import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DbOrTx, Tx } from "../db/client";
import {
  audit,
  openingConsents,
  deliveries,
  devices,
  entitlements,
  messages,
  outbox,
  profiles,
  recipients,
  releases,
  systemHealth,
  user,
  type Profile,
} from "../db/schema";
import type { Env } from "../env";
import { hash, randomToken, Vault } from "../lib/crypto";
import { AppError, requireValue } from "../lib/errors";
import { enqueue } from "./notifications";

export const DAY = 86_400_000;
export const OPENING_NOTICE_VERSION = "2026-10-14-v1";
export const OPENING_NOTICE =
  "この通知は、送信者の死亡を確認したものではありません。送信者が亡くなったことを別の手段で確認してから、伝言を開いてください。この同意は受取人の自己申告であり、公的な死亡確認や受取人認証を代替しません。";
export const CONSENT_VERSION = "2026-10-13-v1";
export interface Contact {
  name: string;
  email: string;
  phone?: string;
}
export interface MessageBody {
  title: string;
  body: string;
}
export const isEntitled = (e: typeof entitlements.$inferSelect | undefined, now: number) =>
  !!e && (e.status === "active" || e.status === "grace") && e.validUntil > now;
export const recipientLimit = (plan?: string) => (plan === "plus" ? 50 : 10);
export async function log(
  db: DbOrTx,
  p: Pick<Profile, "id" | "version">,
  action: string,
  now: number,
) {
  await db.insert(audit).values({
    id: crypto.randomUUID(),
    profileId: p.id,
    version: p.version,
    action,
    createdAt: now,
  });
}
export async function invalidate(
  tx: Tx,
  p: Profile,
  state: Profile["state"],
  now: number,
  reason: string | null = null,
) {
  const next = requireValue(
    (
      await tx
        .update(profiles)
        .set({
          state,
          version: p.version + 1,
          graceStartedAt: null,
          warningAcceptedAt: null,
          holdReason: reason,
          updatedAt: now,
        })
        .where(and(eq(profiles.id, p.id), eq(profiles.version, p.version)))
        .returning()
    )[0],
    "VERSION_CONFLICT",
  );
  await tx
    .update(outbox)
    .set({ state: "cancelled", payload: "" })
    .where(
      and(
        eq(outbox.profileId, p.id),
        inArray(outbox.state, ["pending"]),
        inArray(outbox.kind, ["final", "warning", "reminder"]),
      ),
    );
  await tx.update(releases).set({ revokedAt: now }).where(eq(releases.profileId, p.id));
  return next;
}
export class SwitchService {
  readonly vault: Vault;
  constructor(
    readonly db: Database,
    readonly env: Env,
    readonly now: () => number = Date.now,
  ) {
    this.vault = new Vault(env);
  }
  async profile(userId: string, db: DbOrTx = this.db) {
    const now = this.now();
    await db
      .insert(profiles)
      .values({ id: crypto.randomUUID(), userId, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: profiles.userId });
    return requireValue((await db.select().from(profiles).where(eq(profiles.userId, userId)))[0]);
  }
  async owned(tx: DbOrTx, userId: string, version?: number) {
    const p = requireValue(
      (await tx.select().from(profiles).where(eq(profiles.userId, userId)))[0],
    );
    if (version !== undefined && p.version !== version) throw new AppError(409, "VERSION_CONFLICT");
    return p;
  }
  async status(userId: string) {
    const p = await this.profile(userId);
    const entitlement =
      (await this.db.select().from(entitlements).where(eq(entitlements.profileId, p.id)))[0] ??
      null;
    const deadline = p.lastCheckInAt === null ? null : p.lastCheckInAt + p.inactivityDays * DAY;
    return {
      ...p,
      entitlement,
      confirmationDueAt: deadline,
      earliestReleaseAt:
        p.warningAcceptedAt === null ? null : p.warningAcceptedAt + p.graceDays * DAY,
      consentVersion: CONSENT_VERSION,
    };
  }
  private editable(p: Profile) {
    if (!["draft", "paused", "held"].includes(p.state))
      throw new AppError(409, "PAUSE_BEFORE_EDITING");
  }
  async changeSettings(
    userId: string,
    data: { version: number; inactivityDays: number; graceDays: number },
  ) {
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId, data.version);
        this.editable(p);
        const next = requireValue(
          (
            await tx
              .update(profiles)
              .set({
                inactivityDays: data.inactivityDays,
                graceDays: data.graceDays,
                version: p.version + 1,
                updatedAt: this.now(),
              })
              .where(eq(profiles.id, p.id))
              .returning()
          )[0],
        );
        await log(tx, next, "settings_updated", this.now());
        return next;
      },
      { behavior: "immediate" },
    );
  }
  async addRecipient(
    userId: string,
    data: Contact & { version: number; channel: "email" | "sms" },
  ) {
    if (data.channel !== "email") throw new AppError(422, "SMS_NOT_SUPPORTED");
    const id = crypto.randomUUID();
    const contact = await this.vault.seal(
      { name: data.name, email: data.email.toLowerCase() },
      `recipient:${id}`,
    );
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId, data.version);
        this.editable(p);
        const e = (await tx.select().from(entitlements).where(eq(entitlements.profileId, p.id)))[0];
        const current = await tx
          .select({ id: recipients.id })
          .from(recipients)
          .where(eq(recipients.profileId, p.id));
        if (current.length >= recipientLimit(isEntitled(e, this.now()) ? e?.plan : undefined))
          throw new AppError(422, "RECIPIENT_LIMIT");
        await tx
          .insert(recipients)
          .values({ id, profileId: p.id, channel: data.channel, contact, createdAt: this.now() });
        await tx
          .update(profiles)
          .set({ version: p.version + 1, updatedAt: this.now() })
          .where(eq(profiles.id, p.id));
        await log(tx, { ...p, version: p.version + 1 }, "recipient_created", this.now());
        return { id, version: p.version + 1, status: "pending" };
      },
      { behavior: "immediate" },
    );
  }
  async listRecipients(userId: string) {
    const p = await this.profile(userId);
    const rows = await this.db.select().from(recipients).where(eq(recipients.profileId, p.id));
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        channel: r.channel,
        status: r.status,
        acceptedAt: r.acceptedAt,
        ...(await this.vault.open<Contact>(r.contact, `recipient:${r.id}`)),
      })),
    );
  }
  async deleteRecipient(userId: string, id: string, version: number) {
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId, version);
        this.editable(p);
        requireValue(
          (
            await tx
              .delete(recipients)
              .where(and(eq(recipients.id, id), eq(recipients.profileId, p.id)))
              .returning()
          )[0],
        );
        await tx
          .update(profiles)
          .set({ version: p.version + 1, updatedAt: this.now() })
          .where(eq(profiles.id, p.id));
        await log(tx, { ...p, version: p.version + 1 }, "recipient_deleted", this.now());
        return { version: p.version + 1 };
      },
      { behavior: "immediate" },
    );
  }
  async writeMessage(userId: string, recipientId: string, data: MessageBody & { version: number }) {
    const ciphertext = await this.vault.seal(
      { title: data.title, body: data.body },
      `message:${recipientId}`,
    );
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId, data.version);
        this.editable(p);
        requireValue(
          (
            await tx
              .select()
              .from(recipients)
              .where(and(eq(recipients.id, recipientId), eq(recipients.profileId, p.id)))
          )[0],
        );
        const row = requireValue(
          (
            await tx
              .insert(messages)
              .values({
                id: crypto.randomUUID(),
                profileId: p.id,
                recipientId,
                ciphertext,
                updatedAt: this.now(),
              })
              .onConflictDoUpdate({
                target: messages.recipientId,
                set: { ciphertext, revision: sql`${messages.revision} + 1`, updatedAt: this.now() },
              })
              .returning()
          )[0],
        );
        await tx
          .update(profiles)
          .set({ version: p.version + 1, updatedAt: this.now() })
          .where(eq(profiles.id, p.id));
        await log(tx, { ...p, version: p.version + 1 }, "message_updated", this.now());
        return { id: row.id, revision: row.revision, version: p.version + 1 };
      },
      { behavior: "immediate" },
    );
  }
  async listMessages(userId: string) {
    const p = await this.profile(userId);
    const rows = await this.db.select().from(messages).where(eq(messages.profileId, p.id));
    return Promise.all(
      rows.map(async (m) => ({
        id: m.id,
        recipientId: m.recipientId,
        revision: m.revision,
        updatedAt: m.updatedAt,
        ...(await this.vault.open<MessageBody>(m.ciphertext, `message:${m.recipientId}`)),
      })),
    );
  }
  async deleteMessage(userId: string, recipientId: string, version: number) {
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId, version);
        this.editable(p);
        requireValue(
          (
            await tx
              .delete(messages)
              .where(and(eq(messages.profileId, p.id), eq(messages.recipientId, recipientId)))
              .returning()
          )[0],
        );
        await tx
          .update(profiles)
          .set({ version: p.version + 1 })
          .where(eq(profiles.id, p.id));
        await log(tx, { ...p, version: p.version + 1 }, "message_deleted", this.now());
        return { version: p.version + 1 };
      },
      { behavior: "immediate" },
    );
  }
  async invite(userId: string, recipientId: string) {
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId);
        this.editable(p);
        const r = requireValue(
          (
            await tx
              .select()
              .from(recipients)
              .where(and(eq(recipients.id, recipientId), eq(recipients.profileId, p.id)))
          )[0],
        );
        if (r.status !== "pending") throw new AppError(409, "INVITATION_NOT_ALLOWED");
        if (r.lastInvitedAt && this.now() - r.lastInvitedAt < DAY)
          throw new AppError(429, "INVITATION_COOLDOWN");
        const token = randomToken(),
          now = this.now(),
          expiresAt = now + 7 * DAY;
        const contact = await this.vault.open<Contact>(r.contact, `recipient:${r.id}`);
        const sender = requireValue(
          (await tx.select({ name: user.name }).from(user).where(eq(user.id, userId)))[0],
        );
        await tx
          .update(recipients)
          .set({
            invitationHash: await hash(token),
            invitationExpiresAt: expiresAt,
            lastInvitedAt: now,
          })
          .where(eq(recipients.id, r.id));
        await enqueue(
          tx,
          this.vault,
          "invitation",
          `invite:${r.id}:${now}`,
          {
            channel: "email",
            to: contact.email,
            template: "invitation",
            senderName: sender.name.slice(0, 100),
            url: `${this.env.RECIPIENT_WEB_URL}/invitations#${token}`,
            expiresAt,
          },
          now,
          { profileId: p.id, recipientId: r.id },
        );
        await log(tx, p, "invitation_requested", now);
      },
      { behavior: "immediate" },
    );
  }
  async respondInvitation(email: string, token: string, action: "accept" | "decline" | "report") {
    const tokenHash = await hash(token);
    return this.db.transaction(
      async (tx) => {
        const r = requireValue(
          (await tx.select().from(recipients).where(eq(recipients.invitationHash, tokenHash)))[0],
        );
        const contact = await this.vault.open<Contact>(r.contact, `recipient:${r.id}`);
        if (contact.email !== email.toLowerCase()) throw new AppError(404, "NOT_FOUND");
        if (!r.invitationExpiresAt || r.invitationExpiresAt <= this.now() || r.status !== "pending")
          throw new AppError(409, "INVITATION_EXPIRED");
        if (action === "accept" && r.channel !== "email")
          throw new AppError(422, "SMS_NOT_SUPPORTED");
        await tx
          .update(recipients)
          .set({
            status:
              action === "accept" ? "accepted" : action === "decline" ? "declined" : "reported",
            acceptedAt: action === "accept" ? this.now() : null,
            invitationHash: null,
          })
          .where(eq(recipients.id, r.id));
        const p = requireValue(
          (await tx.select().from(profiles).where(eq(profiles.id, r.profileId)))[0],
        );
        await tx
          .update(profiles)
          .set({ version: p.version + 1, updatedAt: this.now() })
          .where(eq(profiles.id, p.id));
        await log(tx, { ...p, version: p.version + 1 }, `recipient_${action}`, this.now());
        return { status: action };
      },
      { behavior: "immediate" },
    );
  }
  async previewInvitation(email: string, token: string) {
    const r = requireValue(
      (
        await this.db
          .select()
          .from(recipients)
          .where(eq(recipients.invitationHash, await hash(token)))
      )[0],
    );
    const contact = await this.vault.open<Contact>(r.contact, `recipient:${r.id}`);
    if (
      contact.email !== email.toLowerCase() ||
      !r.invitationExpiresAt ||
      r.invitationExpiresAt <= this.now()
    )
      throw new AppError(404, "NOT_FOUND");
    const sender = requireValue(
      (
        await this.db
          .select({ name: user.name })
          .from(profiles)
          .innerJoin(user, eq(profiles.userId, user.id))
          .where(eq(profiles.id, r.profileId))
      )[0],
    );
    return {
      recipientId: r.id,
      channel: r.channel,
      status: r.status,
      name: contact.name,
      senderName: sender.name,
      expiresAt: r.invitationExpiresAt,
    };
  }
  async withdrawConsent(email: string, recipientId: string, action: "decline" | "report") {
    return this.db.transaction(
      async (tx) => {
        const r = requireValue(
          (await tx.select().from(recipients).where(eq(recipients.id, recipientId)))[0],
        );
        const contact = await this.vault.open<Contact>(r.contact, `recipient:${r.id}`);
        if (contact.email !== email.toLowerCase()) throw new AppError(404, "NOT_FOUND");
        await tx
          .update(recipients)
          .set({ status: action === "decline" ? "declined" : "reported", invitationHash: null })
          .where(eq(recipients.id, r.id));
        await tx
          .update(deliveries)
          .set({ revokedAt: this.now() })
          .where(eq(deliveries.recipientId, r.id));
        const p = requireValue(
          (await tx.select().from(profiles).where(eq(profiles.id, r.profileId)))[0],
        );
        const next = await invalidate(
          tx,
          p,
          ["active", "grace", "released"].includes(p.state) ? "held" : p.state,
          this.now(),
          "recipient_withdrew",
        );
        await log(tx, next, `recipient_${action}`, this.now());
        return { status: action };
      },
      { behavior: "immediate" },
    );
  }
  async activate(userId: string, version: number, consentVersion: string) {
    if (consentVersion !== CONSENT_VERSION) throw new AppError(422, "CONSENT_VERSION_REQUIRED");
    return this.db.transaction(
      async (tx) => {
        const now = this.now(),
          p = await this.owned(tx, userId, version);
        this.editable(p);
        const u = requireValue((await tx.select().from(user).where(eq(user.id, userId)))[0]);
        if (!u.emailVerified) throw new AppError(422, "VERIFIED_EMAIL_REQUIRED");
        const e = (await tx.select().from(entitlements).where(eq(entitlements.profileId, p.id)))[0];
        if (!isEntitled(e, now)) throw new AppError(422, "ACTIVE_ENTITLEMENT_REQUIRED");
        const health = (
          await tx.select().from(systemHealth).where(eq(systemHealth.id, "scheduler"))
        )[0];
        if (
          !health?.lastTickAt ||
          !health.lastProbeAt ||
          now - health.lastTickAt > 300_000 ||
          now - health.lastProbeAt > 300_000 ||
          health.incidentAt
        )
          throw new AppError(503, "MONITORING_UNHEALTHY");
        if (this.env.DELIVERY_ENABLED !== "true") throw new AppError(503, "DELIVERY_DISABLED");
        const selfTest =
          (
            await tx
              .select({ id: outbox.id })
              .from(outbox)
              .where(
                and(
                  eq(outbox.profileId, p.id),
                  eq(outbox.kind, "self_test"),
                  inArray(outbox.state, ["accepted", "delivered"]),
                ),
              )
          ).length > 0;
        if (!selfTest) throw new AppError(422, "SELF_TEST_REQUIRED");
        const rs = await tx.select().from(recipients).where(eq(recipients.profileId, p.id));
        const ms = await tx.select().from(messages).where(eq(messages.profileId, p.id));
        if (rs.some((r) => r.channel !== "email")) throw new AppError(422, "SMS_NOT_SUPPORTED");
        if (
          !rs.length ||
          rs.length > recipientLimit(e?.plan) ||
          rs.some((r) => r.status !== "accepted" || !ms.some((m) => m.recipientId === r.id))
        )
          throw new AppError(422, "RECIPIENTS_NOT_READY");
        const next = await invalidate(tx, p, "active", now);
        await tx
          .update(profiles)
          .set({ lastCheckInAt: now, lastReminderAt: now })
          .where(eq(profiles.id, p.id));
        await log(tx, next, `activated:${consentVersion}`, now);
        return { ...next, lastCheckInAt: now, lastReminderAt: now };
      },
      { behavior: "immediate" },
    );
  }
  async checkIn(userId: string, kind: "foreground" | "notification_action") {
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId),
          now = this.now();
        const next = await invalidate(
          tx,
          p,
          p.state === "active" || p.state === "grace"
            ? "active"
            : p.state === "released"
              ? "paused"
              : p.state,
          now,
          p.state === "held" ? p.holdReason : null,
        );
        await tx
          .update(profiles)
          .set({ lastCheckInAt: now, lastReminderAt: now })
          .where(eq(profiles.id, p.id));
        await log(tx, next, `check_in:${kind}`, now);
        return { ...next, lastCheckInAt: now, lastReminderAt: now };
      },
      { behavior: "immediate" },
    );
  }
  async pause(userId: string) {
    return this.db.transaction(
      async (tx) => {
        const p = await this.owned(tx, userId),
          now = this.now();
        const next = await invalidate(tx, p, "paused", now);
        await log(tx, next, "paused", now);
        return next;
      },
      { behavior: "immediate" },
    );
  }
  async readDelivery(
    email: string,
    token: string,
    action: "preview" | "read" | "decline" | "report",
    consent?: { deathConfirmed: true; noticeVersion: string },
  ) {
    return this.db.transaction(
      async (tx) => {
        const d = requireValue(
          (
            await tx
              .select()
              .from(deliveries)
              .where(eq(deliveries.tokenHash, await hash(token)))
          )[0],
        );
        const r = requireValue(
          (await tx.select().from(recipients).where(eq(recipients.id, d.recipientId)))[0],
        );
        const c = await this.vault.open<Contact>(r.contact, `recipient:${r.id}`);
        if (c.email !== email.toLowerCase()) throw new AppError(404, "NOT_FOUND");
        const release = requireValue(
          (await tx.select().from(releases).where(eq(releases.id, d.releaseId)))[0],
        );
        const p = requireValue(
          (await tx.select().from(profiles).where(eq(profiles.id, release.profileId)))[0],
        );
        if (action === "decline" || action === "report") {
          await tx
            .update(recipients)
            .set({ status: action === "decline" ? "declined" : "reported" })
            .where(eq(recipients.id, r.id));
          await tx
            .update(deliveries)
            .set({ revokedAt: this.now() })
            .where(eq(deliveries.recipientId, r.id));
          await tx
            .update(outbox)
            .set({ state: "cancelled", payload: "" })
            .where(
              and(
                eq(outbox.recipientId, r.id),
                eq(outbox.kind, "final"),
                eq(outbox.state, "pending"),
              ),
            );
          await log(tx, p, `recipient_${action}`, this.now());
          return { status: action };
        }
        if (
          d.revokedAt ||
          release.revokedAt ||
          d.expiresAt <= this.now() ||
          r.status !== "accepted" ||
          p.state !== "released" ||
          p.version !== release.version
        )
          throw new AppError(404, "NOT_FOUND");
        if (action === "preview") {
          const sender = requireValue(
            (await tx.select({ name: user.name }).from(user).where(eq(user.id, p.userId)))[0],
          );
          return {
            senderName: sender.name,
            notice: OPENING_NOTICE,
            noticeVersion: OPENING_NOTICE_VERSION,
            expiresAt: d.expiresAt,
          };
        }
        if (action !== "read" || consent?.deathConfirmed !== true)
          throw new AppError(422, "OPENING_CONSENT_REQUIRED");
        if (consent.noticeVersion !== OPENING_NOTICE_VERSION)
          throw new AppError(422, "OPENING_NOTICE_VERSION_REQUIRED");
        const actor = requireValue(
          (
            await tx
              .select({ id: user.id })
              .from(user)
              .where(and(eq(user.email, email.toLowerCase()), eq(user.emailVerified, true)))
          )[0],
        );
        const message = await this.vault.open<MessageBody>(d.ciphertext, `delivery:${d.id}`);
        // The immediate transaction serializes stop/check-in/withdrawal with opening.
        // Recheck the clock after asynchronous crypto, before recording consent or disclosure.
        const snapshotHash = await hash(d.ciphertext);
        const confirmedAt = this.now();
        if (d.expiresAt <= confirmedAt) throw new AppError(404, "NOT_FOUND");
        const inserted = await tx
          .insert(openingConsents)
          .values({
            id: crypto.randomUUID(),
            userId: actor.id,
            deliveryId: d.id,
            releaseId: release.id,
            recipientId: r.id,
            messageRevision: d.messageRevision,
            snapshotHash,
            noticeVersion: consent.noticeVersion,
            confirmedAt,
          })
          .onConflictDoNothing()
          .returning({ id: openingConsents.id });
        if (inserted.length) await log(tx, p, "recipient_opening_consented", confirmedAt);
        await tx
          .update(deliveries)
          .set({ viewedAt: d.viewedAt ?? confirmedAt })
          .where(eq(deliveries.id, d.id));
        return { message, expiresAt: d.expiresAt };
      },
      { behavior: "immediate" },
    );
  }
  async addDevice(userId: string, token: string) {
    const p = await this.profile(userId),
      tokenHash = await hash(token),
      id = crypto.randomUUID();
    return this.db.transaction(
      async (tx) => {
        const existing = (
          await tx.select().from(devices).where(eq(devices.tokenHash, tokenHash))
        )[0];
        if (existing) {
          if (existing.profileId !== p.id) throw new AppError(409, "DEVICE_ALREADY_REGISTERED");
          return { id: existing.id };
        }
        if (
          (await tx.select({ id: devices.id }).from(devices).where(eq(devices.profileId, p.id)))
            .length >= 5
        )
          throw new AppError(422, "DEVICE_LIMIT");
        await tx.insert(devices).values({
          id,
          profileId: p.id,
          tokenHash,
          token: await this.vault.seal(token, `device:${id}`),
          createdAt: this.now(),
        });
        await log(tx, p, "device_added", this.now());
        return { id };
      },
      { behavior: "immediate" },
    );
  }
}
