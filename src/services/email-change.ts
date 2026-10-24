import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { atomic, type Database } from "../db/client";
import {
  authLinkBindings,
  contactVerifications,
  deviceCredentials,
  devices,
  emailChanges,
  outbox,
  profiles,
  restoreOperations,
  session,
  user,
  verification,
} from "../db/schema";
import type { Env } from "../config";
import { AppError, requireValue } from "../lib/errors";
import { hash, randomToken, Vault } from "../lib/crypto";
import { invalidate, log } from "./switch";
import { enqueue } from "./notifications";

export class EmailChangeService {
  private vault: Vault;
  constructor(
    private db: Database,
    private env: Env,
    private now: () => number = Date.now,
  ) {
    this.vault = new Vault(env);
  }
  private async credential(tx: Database, userId: string, credentialId: string) {
    const credential = (
      await tx
        .select()
        .from(deviceCredentials)
        .where(
          and(
            eq(deviceCredentials.id, credentialId),
            eq(deviceCredentials.userId, userId),
            gt(deviceCredentials.expiresAt, this.now()),
          ),
        )
    )[0];
    if (!credential) throw new AppError(401, "AUTHENTICATION_REQUIRED");
    return credential;
  }
  async status(userId: string, credentialId: string) {
    const row = (
      await this.db
        .select()
        .from(emailChanges)
        .where(
          and(
            eq(emailChanges.userId, userId),
            eq(emailChanges.credentialId, credentialId),
            gt(emailChanges.expiresAt, this.now()),
          ),
        )
    )[0];
    return {
      change: row
        ? {
            id: row.id,
            email: await this.vault.open<string>(row.email, `email-change:${row.id}`),
            step: row.step,
            expiresAt: row.expiresAt,
          }
        : null,
    };
  }
  async start(userId: string, credentialId: string, email: string) {
    email = email.toLowerCase();
    return atomic(this.db, async (tx) => {
      await this.credential(tx, userId, credentialId);
      const owner = requireValue((await tx.select().from(user).where(eq(user.id, userId)))[0]);
      if (!owner.emailVerified) throw new AppError(403, "VERIFIED_EMAIL_REQUIRED");
      if (email === owner.email) throw new AppError(409, "EMAIL_UNCHANGED");
      if ((await tx.select().from(user).where(eq(user.email, email))).length)
        throw new AppError(409, "EMAIL_ALREADY_LINKED_USE_RECOVERY");
      const previous = (
        await tx.select().from(emailChanges).where(eq(emailChanges.userId, userId))
      )[0];
      if (previous && previous.expiresAt > this.now())
        throw new AppError(409, "EMAIL_CHANGE_IN_PROGRESS");
      const id = crypto.randomUUID(),
        token = randomToken(),
        expiresAt = this.now() + 600_000;
      const p = requireValue(
        (await tx.select().from(profiles).where(eq(profiles.userId, userId)))[0],
      );
      const next = await invalidate(tx, p, "paused", this.now());
      await tx.delete(emailChanges).where(eq(emailChanges.userId, userId));
      await tx.insert(emailChanges).values({
        userId,
        id,
        credentialId,
        email: await this.vault.seal(email, `email-change:${id}`),
        oldEmail: owner.email,
        generation: owner.authGeneration,
        tokenHash: await hash(token),
        step: "verify_old",
        expiresAt,
      });
      await enqueue(
        tx,
        this.vault,
        "auth",
        `email-change:${id}:old`,
        {
          channel: "email",
          to: owner.email,
          template: "email_change_old",
          url: `${this.env.RECIPIENT_WEB_URL}/confirm-contact-change#${token}`,
          expiresAt,
        },
        this.now(),
        { profileId: p.id },
      );
      await log(tx, next, "email_change_started", this.now());
      return { changeId: id, step: "verify_old" as const, expiresAt };
    });
  }
  async cancel(userId: string, credentialId: string) {
    await atomic(this.db, async (tx) => {
      await this.credential(tx, userId, credentialId);
      const row = (await tx.select().from(emailChanges).where(eq(emailChanges.userId, userId)))[0];
      if (row && row.credentialId !== credentialId)
        throw new AppError(403, "EMAIL_CHANGE_DEVICE_REQUIRED");
      await tx.delete(emailChanges).where(eq(emailChanges.userId, userId));
      if (row)
        await tx
          .update(outbox)
          .set({ state: "cancelled", payload: "" })
          .where(
            and(
              inArray(outbox.dedupeKey, [
                `email-change:${row.id}:old`,
                `email-change:${row.id}:new`,
              ]),
              eq(outbox.state, "pending"),
            ),
          );
    });
  }
  async confirm(userId: string, credentialId: string, token: string) {
    return atomic(this.db, async (tx) => {
      await this.credential(tx, userId, credentialId);
      const now = this.now();
      const row = (
        await tx
          .select()
          .from(emailChanges)
          .where(
            and(
              eq(emailChanges.userId, userId),
              eq(emailChanges.credentialId, credentialId),
              eq(emailChanges.tokenHash, await hash(token)),
              gt(emailChanges.expiresAt, now),
            ),
          )
      )[0];
      if (!row) throw new AppError(400, "INVALID_EMAIL_CHANGE_LINK");
      const owner = requireValue((await tx.select().from(user).where(eq(user.id, userId)))[0]);
      if (owner.email !== row.oldEmail || owner.authGeneration !== row.generation)
        throw new AppError(409, "EMAIL_CHANGE_INVALIDATED");
      const email = await this.vault.open<string>(row.email, `email-change:${row.id}`);
      const p = requireValue(
        (await tx.select().from(profiles).where(eq(profiles.userId, userId)))[0],
      );
      if (this.now() >= row.expiresAt) throw new AppError(400, "INVALID_EMAIL_CHANGE_LINK");
      if (row.step === "verify_old") {
        const newToken = randomToken();
        await tx
          .update(emailChanges)
          .set({ step: "verify_new", tokenHash: await hash(newToken) })
          .where(eq(emailChanges.userId, userId));
        await enqueue(
          tx,
          this.vault,
          "auth",
          `email-change:${row.id}:new`,
          {
            channel: "email",
            to: email,
            template: "email_change_new",
            url: `${this.env.RECIPIENT_WEB_URL}/confirm-contact-change#${newToken}`,
            expiresAt: row.expiresAt,
          },
          now,
          { profileId: p.id },
        );
        return { step: "verify_new" as const, expiresAt: row.expiresAt };
      }
      if (
        (
          await tx
            .select()
            .from(user)
            .where(and(eq(user.email, email), ne(user.id, userId)))
        ).length
      )
        throw new AppError(409, "EMAIL_ALREADY_LINKED_USE_RECOVERY");
      await tx
        .update(user)
        .set({
          email,
          emailVerified: true,
          authGeneration: owner.authGeneration + 1,
          selfTestRequiredAfter: now,
          updatedAt: new Date(now),
        })
        .where(eq(user.id, userId));
      await tx.delete(session).where(eq(session.userId, userId));
      await tx.delete(authLinkBindings).where(eq(authLinkBindings.userId, userId));
      // CASE protects unrelated non-JSON verification records; delete matched mail proofs in one statement.
      await tx.delete(verification).where(sql`CASE WHEN json_valid(${verification.value}) THEN
        json_extract(${verification.value}, '$.type') = 'magic-link' AND
        json_extract(${verification.value}, '$.email') IN (${owner.email}, ${email}) ELSE 0 END`);
      const registrations = await tx.select().from(devices).where(eq(devices.profileId, p.id));
      for (const d of registrations)
        if (d.credentialId !== credentialId) await tx.delete(devices).where(eq(devices.id, d.id));
      await tx
        .delete(deviceCredentials)
        .where(and(eq(deviceCredentials.userId, userId), ne(deviceCredentials.id, credentialId)));
      await tx.delete(contactVerifications).where(eq(contactVerifications.userId, userId));
      await tx.delete(restoreOperations).where(eq(restoreOperations.targetUserId, userId));
      await tx.delete(emailChanges).where(eq(emailChanges.userId, userId));
      // Prior self-tests and unsent owner authentication mail cannot establish the new contact.
      await tx
        .update(outbox)
        .set({ state: "cancelled", payload: "" })
        .where(
          and(
            eq(outbox.profileId, p.id),
            eq(outbox.state, "pending"),
            inArray(outbox.kind, ["auth", "self_test"]),
          ),
        );
      for (const to of [owner.email, email])
        await enqueue(
          tx,
          this.vault,
          "auth",
          `email-change:${row.id}:done:${to === email ? "new" : "old"}`,
          { channel: "email", to, template: "email_change_complete" },
          now,
          { profileId: p.id },
        );
      if (this.now() >= row.expiresAt) throw new AppError(400, "INVALID_EMAIL_CHANGE_LINK");
      const next = await invalidate(tx, p, "paused", now);
      await log(tx, next, "email_changed", now);
      return { verified: true as const };
    });
  }
}
