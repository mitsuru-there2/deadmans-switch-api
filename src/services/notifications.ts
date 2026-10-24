import { atomic } from "../db/client";
import { and, count, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, DbOrTx } from "../db/client";
import {
  outbox,
  profiles,
  recipients,
  entitlements,
  systemHealth,
  releases,
  devices,
  emailChanges,
  authLinkBindings,
  user,
} from "../db/schema";
import type { Env } from "../config";
import { hash, Vault } from "../lib/crypto";

export interface Notice {
  channel: "email" | "sms" | "push";
  to: string;
  template:
    | "email_change_old"
    | "email_change_new"
    | "email_change_complete"
    | "magic_link"
    | "contact_verification"
    | "invitation"
    | "reminder"
    | "warning"
    | "final"
    | "self_test";
  // No message body is ever included in notifications.
  url?: string;
  scheduledAt?: number;
  expiresAt?: number;
  senderName?: string;
}
export interface NoticeContext {
  contactGeneration?: number;
  profileId?: string;
  recipientId?: string;
  deviceId?: string;
  version?: number;
}
export async function enqueue(
  db: DbOrTx,
  vault: Vault,
  kind: typeof outbox.$inferInsert.kind,
  key: string,
  payload: Notice,
  now: number,
  context: NoticeContext = {},
) {
  const id = crypto.randomUUID();
  await db
    .insert(outbox)
    .values({
      id,
      kind,
      dedupeKey: key,
      payload: await vault.seal(payload, `outbox:${id}`),
      createdAt: now,
      availableAt: now,
      ...context,
    })
    .onConflictDoNothing({ target: outbox.dedupeKey });
  return id;
}
export type TransportResult =
  | { state: "accepted"; providerId: string }
  | { state: "failed" | "uncertain" };
export type Transport = (id: string, payload: Notice) => Promise<TransportResult>;
export function gatewayTransport(env: Env): Transport {
  return async (id, payload) => {
    if (payload.channel === "sms") return { state: "failed" };
    if (!env.NOTIFICATION_GATEWAY_URL || !env.NOTIFICATION_GATEWAY_SECRET)
      return { state: "failed" };
    try {
      const response = await fetch(`${env.NOTIFICATION_GATEWAY_URL}/v1/notifications`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.NOTIFICATION_GATEWAY_SECRET}`,
          "Idempotency-Key": id,
        },
        body: JSON.stringify({ id, ...payload }),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      // A non-2xx or malformed response cannot prove that the provider did not accept it.
      if (!response.ok) {
        console.warn("notification_gateway_http_error", response.status);
        return { state: "uncertain" };
      }
      const result = z
        .object({ state: z.literal("accepted"), providerId: z.string().min(1) })
        .safeParse(await response.json());
      return result.success ? result.data : { state: "uncertain" };
    } catch (error) {
      console.warn("notification_gateway_error", error instanceof Error ? error.name : "unknown");
      return { state: "uncertain" };
    }
  };
}
export async function dispatch(
  db: Database,
  env: Env,
  vault: Vault,
  transport: Transport,
  fixedNow?: number,
) {
  const clock = () => fixedNow ?? Date.now();
  const now = clock();
  // A crash after the claim may have sent the message. Never blindly retry it.
  await db
    .update(outbox)
    .set({ state: "uncertain" })
    .where(and(eq(outbox.state, "sending"), lte(outbox.claimedAt, now - 120_000)));
  const jobs = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.state, "pending"), lte(outbox.availableAt, now)))
    .limit(50);
  for (const candidate of jobs) {
    const now = clock();
    const job = await atomic(db, async (tx) => {
      const row = (
        await tx
          .select()
          .from(outbox)
          .where(and(eq(outbox.id, candidate.id), eq(outbox.state, "pending")))
      )[0];
      if (!row) return null;
      const notice = await vault.open<Notice>(row.payload, `outbox:${row.id}`);
      // Cancel legacy SMS jobs before any transport or operational checks.
      if (notice.channel === "sms") {
        await tx
          .update(outbox)
          .set({ state: "cancelled", payload: "" })
          .where(eq(outbox.id, row.id));
        return null;
      }
      let valid = !notice.expiresAt || notice.expiresAt > now;
      if (notice.template === "email_change_old" || notice.template === "email_change_new") {
        const pending = row.profileId
          ? (
              await tx
                .select({ change: emailChanges })
                .from(emailChanges)
                .innerJoin(profiles, eq(profiles.userId, emailChanges.userId))
                .where(eq(profiles.id, row.profileId))
            )[0]?.change
          : undefined;
        valid &&=
          !!pending &&
          pending.expiresAt > now &&
          pending.tokenHash === (await hash(notice.url?.split("#")[1] ?? ""));
      }
      if (notice.template === "magic_link") {
        const token = new URL(notice.url!).searchParams.get("token") ?? "";
        const proof = (
          await tx
            .select()
            .from(authLinkBindings)
            .where(eq(authLinkBindings.tokenHash, await hash(token)))
        )[0];
        const owner = (await tx.select().from(user).where(eq(user.email, notice.to)))[0];
        valid &&=
          !!proof &&
          proof.expiresAt > now &&
          (!owner ||
            (owner.authGeneration === proof.generation &&
              (!proof.userId || proof.userId === owner.id)));
      }
      if (row.profileId && row.version !== null) {
        const p = (await tx.select().from(profiles).where(eq(profiles.id, row.profileId)))[0];
        valid &&= !!p && p.version === row.version;
        if (row.kind === "final" || row.kind === "warning" || row.kind === "reminder") {
          const health = (
            await tx.select().from(systemHealth).where(eq(systemHealth.id, "scheduler"))
          )[0];
          const healthy =
            !!health?.lastTickAt &&
            now - health.lastTickAt <= 300_000 &&
            !!health.lastProbeAt &&
            now - health.lastProbeAt <= 300_000 &&
            !health.incidentAt;
          const e = (
            await tx.select().from(entitlements).where(eq(entitlements.profileId, row.profileId))
          )[0];
          const recipientCount = (
            await tx
              .select({ value: count() })
              .from(recipients)
              .where(eq(recipients.profileId, row.profileId))
          )[0]!.value;
          const entitled =
            !!e &&
            (e.status === "active" || e.status === "grace") &&
            e.validUntil > now &&
            recipientCount <= (e.plan === "plus" ? 50 : 10);
          // Kill switch / operational hold preserve pending work, and never cause a burst on recovery.
          if (env.DELIVERY_ENABLED !== "true" || !healthy) return null;
          valid &&=
            entitled &&
            !!p &&
            (row.kind === "final"
              ? p.state === "released"
              : row.kind === "warning"
                ? p.state === "grace"
                : p.state === "active");
        }
      }
      if (row.recipientId) {
        const recipient = (
          await tx.select().from(recipients).where(eq(recipients.id, row.recipientId))
        )[0];
        valid &&=
          !!recipient &&
          (row.kind === "invitation"
            ? recipient.status === "pending"
            : recipient.status === "accepted");
      }
      if (row.kind === "reminder") valid &&= !!row.deviceId;
      if (!valid) {
        await tx
          .update(outbox)
          .set({ state: "cancelled", payload: "" })
          .where(eq(outbox.id, row.id));
        return null;
      }
      await tx
        .update(outbox)
        .set({ state: "sending", claimedAt: now, attempts: sql`${outbox.attempts} + 1` })
        .where(and(eq(outbox.id, row.id), eq(outbox.state, "pending")));
      return { row, notice };
    });
    if (!job) continue;
    let result: TransportResult;
    try {
      result = await transport(job.row.id, job.notice);
    } catch {
      result = { state: "uncertain" };
    }
    await atomic(db, async (tx) => {
      await recordResult(tx, job.row.id, result, clock());
      if (result.state === "failed" && job.notice.channel === "push" && job.row.profileId) {
        await tx
          .delete(devices)
          .where(
            and(
              eq(devices.profileId, job.row.profileId),
              eq(devices.tokenHash, await hash(job.notice.to)),
            ),
          );
      }
    });
  }
}
export async function recordResult(
  db: DbOrTx,
  id: string,
  result: TransportResult | { state: "delivered"; providerId: string },
  now: number,
) {
  const allowed =
    result.state === "failed"
      ? (["sending", "uncertain", "accepted", "delivered"] as const)
      : (["sending", "uncertain", "accepted"] as const);
  const row = (
    await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.id, id), inArray(outbox.state, [...allowed])))
  )[0];
  if (!row) return;
  await db
    .update(outbox)
    .set({
      state: result.state,
      providerId: "providerId" in result ? result.providerId : null,
      ...(result.state === "accepted" || result.state === "delivered" ? { payload: "" } : {}),
    })
    .where(eq(outbox.id, id));
  if (row?.deviceId && result.state === "failed")
    await db.delete(devices).where(eq(devices.id, row.deviceId));
  if (row?.kind === "warning" && row.profileId && row.version !== null) {
    if (result.state === "accepted" || result.state === "delivered") {
      await db
        .update(profiles)
        .set({ warningAcceptedAt: now })
        .where(
          and(
            eq(profiles.id, row.profileId),
            eq(profiles.version, row.version),
            eq(profiles.state, "grace"),
            sql`${profiles.warningAcceptedAt} IS NULL`,
          ),
        );
    } else if (result.state === "failed") {
      const held = await db
        .select()
        .from(profiles)
        .where(
          and(
            eq(profiles.id, row.profileId),
            eq(profiles.version, row.version),
            inArray(profiles.state, ["grace", "released"]),
          ),
        );
      await db
        .update(profiles)
        .set({
          state: "held",
          holdReason: "warning_failed",
          version: sql`${profiles.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(profiles.id, row.profileId),
            eq(profiles.version, row.version),
            inArray(profiles.state, ["grace", "released"]),
          ),
        );
      if (held.length) {
        await db
          .update(releases)
          .set({ revokedAt: now })
          .where(eq(releases.profileId, row.profileId));
        await db
          .update(outbox)
          .set({ state: "cancelled", payload: "" })
          .where(
            and(
              eq(outbox.profileId, row.profileId),
              eq(outbox.state, "pending"),
              eq(outbox.kind, "final"),
            ),
          );
      }
    }
  }
}
