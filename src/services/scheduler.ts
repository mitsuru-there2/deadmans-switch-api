import { atomic } from "../db/client";
import { and, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { purgeRestoreResults } from "./restore-operations";
import {
  deliveries,
  devices,
  entitlements,
  messages,
  profiles,
  recipients,
  releases,
  systemHealth,
  user,
  publicRateLimits,
  webhookEvents,
  verification,
  session,
  deviceCredentials,
  contactVerifications,
} from "../db/schema";
import type { Env } from "../config";
import { hash, randomToken, Vault } from "../lib/crypto";
import { enqueue } from "./notifications";
import {
  type Contact,
  DAY,
  invalidate,
  isEntitled,
  log,
  type MessageBody,
  recipientLimit,
} from "./switch";

const MAX_HEALTH_GAP = 300_000;
export async function probe(db: Database, now = Date.now()) {
  await atomic(db, async (tx) => {
    const h = (await tx.select().from(systemHealth).where(eq(systemHealth.id, "scheduler")))[0];
    await tx
      .insert(systemHealth)
      .values({ id: "scheduler", lastProbeAt: now })
      .onConflictDoUpdate({
        target: systemHealth.id,
        set: {
          lastProbeAt: now,
          ...(h?.lastProbeAt && now - h.lastProbeAt > MAX_HEALTH_GAP
            ? { incidentAt: h.incidentAt ?? now }
            : {}),
        },
      });
  });
}
export async function tick(db: Database, env: Env, now = Date.now()) {
  const vault = new Vault(env);
  const safe = await atomic(db, async (tx) => {
    const h = (await tx.select().from(systemHealth).where(eq(systemHealth.id, "scheduler")))[0];
    const gap = !!h?.lastTickAt && now - h.lastTickAt > MAX_HEALTH_GAP;
    const probeMissing = !h?.lastProbeAt || now - h.lastProbeAt > MAX_HEALTH_GAP;
    const unsafe = gap || probeMissing || !!h?.incidentAt || env.DELIVERY_ENABLED !== "true";
    await tx
      .insert(systemHealth)
      .values({ id: "scheduler", lastTickAt: now })
      .onConflictDoUpdate({
        target: systemHealth.id,
        set: {
          lastTickAt: now,
          ...(gap || (probeMissing && !!h?.lastTickAt) ? { incidentAt: h?.incidentAt ?? now } : {}),
        },
      });
    return !unsafe;
  });
  // Pagination prevents low-ID paused/draft accounts from starving other users.
  let cursor = "";
  while (true) {
    const batch = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(gt(profiles.id, cursor), inArray(profiles.state, ["active", "grace", "released"])))
      .orderBy(profiles.id)
      .limit(100);
    if (!batch.length) break;
    for (const candidate of batch) {
      await atomic(db, async (tx) => {
        const p = (await tx.select().from(profiles).where(eq(profiles.id, candidate.id)))[0];
        if (!p || !["active", "grace", "released"].includes(p.state)) return;
        const hold = async (reason: string) => {
          const next = await invalidate(tx, p, "held", now, reason);
          await log(tx, next, `held:${reason}`, now);
        };
        if (!safe) {
          await hold("operational_incident");
          return;
        }
        const e = (await tx.select().from(entitlements).where(eq(entitlements.profileId, p.id)))[0];
        if (!isEntitled(e, now)) {
          await hold("entitlement_inactive");
          return;
        }
        const registered = (
          await tx.select({ value: count() }).from(recipients).where(eq(recipients.profileId, p.id))
        )[0]!.value;
        if (registered > recipientLimit(e?.plan)) {
          await hold("recipient_limit");
          return;
        }
        if (p.state === "released") return;
        const u = (await tx.select().from(user).where(eq(user.id, p.userId)))[0];
        if (!u?.emailVerified) {
          await hold("recovery_email_unverified");
          return;
        }
        if (p.lastCheckInAt === null) {
          await hold("missing_check_in");
          return;
        }
        const deadline = p.lastCheckInAt + p.inactivityDays * DAY;
        if (p.state === "active" && now >= deadline) {
          await tx
            .update(profiles)
            .set({ state: "grace", graceStartedAt: now, warningAcceptedAt: null, updatedAt: now })
            .where(
              and(
                eq(profiles.id, p.id),
                eq(profiles.version, p.version),
                eq(profiles.state, "active"),
              ),
            );
          await enqueue(
            tx,
            vault,
            "warning",
            `warning:${p.id}:${p.version}`,
            {
              channel: "email",
              to: u.email,
              template: "warning",
              url: `${env.RECIPIENT_WEB_URL}/check-in`,
              scheduledAt: now + p.graceDays * DAY,
            },
            now,
            { profileId: p.id, version: p.version },
          );
          await log(tx, p, "grace_started", now);
          return;
        }
        if (p.state === "active" && (!p.lastReminderAt || now - p.lastReminderAt >= DAY)) {
          const ds = await tx.select().from(devices).where(eq(devices.profileId, p.id));
          for (const d of ds) {
            await enqueue(
              tx,
              vault,
              "reminder",
              `reminder:${d.id}:${p.version}:${Math.floor(now / DAY)}`,
              {
                channel: "push",
                to: await vault.open<string>(d.token, `device:${d.id}`),
                template: "reminder",
                expiresAt: now + DAY,
              },
              now,
              { profileId: p.id, version: p.version, deviceId: d.id },
            );
          }
          await tx.update(profiles).set({ lastReminderAt: now }).where(eq(profiles.id, p.id));
        }
        // Grace starts only when the independent warning email was accepted.
        if (
          p.state !== "grace" ||
          !p.warningAcceptedAt ||
          now < p.warningAcceptedAt + p.graceDays * DAY
        )
          return;
        const rs = await tx.select().from(recipients).where(eq(recipients.profileId, p.id));
        const ms = await tx.select().from(messages).where(eq(messages.profileId, p.id));
        if (
          !rs.length ||
          rs.length > recipientLimit(e?.plan) ||
          rs.some(
            (r) =>
              r.channel !== "email" ||
              r.status !== "accepted" ||
              !ms.some((m) => m.recipientId === r.id),
          )
        ) {
          await hold("recipients_not_ready");
          return;
        }
        const releaseId = crypto.randomUUID();
        await tx
          .insert(releases)
          .values({ id: releaseId, profileId: p.id, version: p.version, createdAt: now });
        for (const r of rs) {
          const m = ms.find((message) => message.recipientId === r.id)!;
          const contact = await vault.open<Contact>(r.contact, `recipient:${r.id}`);
          const id = crypto.randomUUID(),
            token = randomToken(),
            expiresAt = now + 30 * DAY;
          const body = await vault.open<MessageBody>(m.ciphertext, `message:${r.id}`);
          await tx.insert(deliveries).values({
            id,
            releaseId,
            recipientId: r.id,
            messageRevision: m.revision,
            ciphertext: await vault.seal(body, `delivery:${id}`),
            tokenHash: await hash(token),
            expiresAt,
          });
          await enqueue(
            tx,
            vault,
            "final",
            `final:${releaseId}:${r.id}`,
            {
              channel: "email",
              to: contact.email,
              template: "final",
              senderName: u.name.slice(0, 100),
              url: `${env.RECIPIENT_WEB_URL}/receive#${token}`,
              expiresAt,
            },
            now,
            { profileId: p.id, recipientId: r.id, version: p.version },
          );
        }
        await tx
          .update(profiles)
          .set({ state: "released", updatedAt: now })
          .where(and(eq(profiles.id, p.id), eq(profiles.version, p.version)));
        await log(tx, p, "release_prepared", now);
      });
    }
    cursor = batch[batch.length - 1]!.id;
  }
  await db.delete(publicRateLimits).where(lt(publicRateLimits.expiresAt, now));
  await db.delete(webhookEvents).where(lt(webhookEvents.createdAt, now - 90 * DAY));
  await db.delete(verification).where(lt(verification.expiresAt, new Date(now)));
  await db.delete(session).where(lt(session.expiresAt, new Date(now)));
  await db.delete(deviceCredentials).where(lt(deviceCredentials.expiresAt, now));
  await db.delete(contactVerifications).where(lt(contactVerifications.expiresAt, now));
  await purgeRestoreResults(db, now);
  // Erase expired snapshots; do not keep readable content beyond the viewing period.
  await db
    .update(deliveries)
    .set({ ciphertext: "", revokedAt: now })
    .where(and(lt(deliveries.expiresAt, now), sql`${deliveries.revokedAt} IS NULL`));
}
