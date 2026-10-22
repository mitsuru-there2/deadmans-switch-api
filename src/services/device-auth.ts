import { atomic } from "../db/client";
import { and, eq, gt } from "drizzle-orm";
import type { Database, DbOrTx } from "../db/client";
import {
  user,
  deviceCredentials,
  contactVerifications,
  profiles,
  storeSubscriptions,
  entitlements,
  devices,
  outbox,
  session,
} from "../db/schema";
import type { Env } from "../config";
import { hash, randomToken, Vault } from "../lib/crypto";
import { AppError, requireValue } from "../lib/errors";
import { DAY, isEntitled, log } from "./switch";
import type { VerifiedSubscription } from "../integrations/stores";
import { enqueue } from "./notifications";
import { RestoreOperations, type RestoreOperation } from "./restore-operations";

const TOKEN_LIFETIME = 180 * DAY;
export class DeviceAuthService {
  constructor(
    private db: Database,
    private env: Env,
    private now: () => number = Date.now,
  ) {}
  private async issue(db: DbOrTx, userId: string) {
    const token = `dms_${randomToken()}`,
      expiresAt = this.now() + TOKEN_LIFETIME;
    await db.insert(deviceCredentials).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: await hash(token),
      expiresAt,
      createdAt: this.now(),
    });
    return { token, expiresAt };
  }
  async bootstrap() {
    return atomic(this.db, async (tx) => {
      const id = crypto.randomUUID(),
        accountToken = crypto.randomUUID(),
        now = this.now();
      await tx.insert(user).values({
        id,
        name: "登録者",
        email: `${id}@device.invalid`,
        emailVerified: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      await tx
        .insert(profiles)
        .values({ id: accountToken, userId: id, createdAt: now, updatedAt: now });
      return { ...(await this.issue(tx, id)), accountToken, userId: id };
    });
  }
  async authenticate(token: string) {
    if (!/^dms_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = (
      await this.db
        .select({ user })
        .from(deviceCredentials)
        .innerJoin(user, eq(user.id, deviceCredentials.userId))
        .where(
          and(
            eq(deviceCredentials.tokenHash, await hash(token)),
            gt(deviceCredentials.expiresAt, this.now()),
          ),
        )
    )[0];
    return row?.user ?? null;
  }
  async renew(userId: string, currentToken?: string) {
    if (currentToken) {
      const token = `dms_${randomToken()}`,
        expiresAt = this.now() + TOKEN_LIFETIME;
      const updated = await this.db
        .update(deviceCredentials)
        .set({ tokenHash: await hash(token), expiresAt })
        .where(
          and(
            eq(deviceCredentials.userId, userId),
            eq(deviceCredentials.tokenHash, await hash(currentToken)),
            gt(deviceCredentials.expiresAt, this.now()),
          ),
        )
        .returning({ id: deviceCredentials.id });
      if (!updated.length) throw new AppError(401, "AUTHENTICATION_REQUIRED");
      return { token, expiresAt };
    }
    return atomic(this.db, async (tx) => {
      // Email recovery revokes lost-device credentials before establishing a new device.
      await tx.delete(deviceCredentials).where(eq(deviceCredentials.userId, userId));
      return this.issue(tx, userId);
    });
  }
  async revoke(userId: string) {
    await this.db.delete(deviceCredentials).where(eq(deviceCredentials.userId, userId));
  }
  async restore(
    currentUserId: string,
    currentToken: string,
    verified: VerifiedSubscription,
    operation?: RestoreOperation,
  ) {
    const referenceHash = await hash(`${verified.store}:${verified.reference}`);
    const credentialHash = await hash(currentToken);
    return atomic(this.db, async (tx) => {
      const operations = new RestoreOperations(this.db, this.env, this.now);
      if (operation) {
        if (operation.sourceTokenHash !== credentialHash)
          throw new AppError(404, "RESTORE_RESULT_UNAVAILABLE");
        const completed = await operations.completed(tx, operation);
        if (completed) return completed;
      }
      // Recheck after the external store call: a revoked/rotated temporary token cannot finish a restore.
      const credential = (
        await tx
          .select()
          .from(deviceCredentials)
          .where(
            and(
              eq(deviceCredentials.userId, currentUserId),
              eq(deviceCredentials.tokenHash, credentialHash),
              gt(deviceCredentials.expiresAt, this.now()),
            ),
          )
      )[0];
      if (!credential) throw new AppError(401, "AUTHENTICATION_REQUIRED");
      const subscription = (
        await tx
          .select()
          .from(storeSubscriptions)
          .where(
            and(
              eq(storeSubscriptions.store, verified.store),
              eq(storeSubscriptions.referenceHash, referenceHash),
              eq(storeSubscriptions.profileId, verified.accountToken),
            ),
          )
      )[0];
      if (!subscription || subscription.ownerVerifiedAt === null)
        throw new AppError(403, "PURCHASE_NOT_REGISTERED");
      if (
        !["active", "grace"].includes(subscription.status) ||
        subscription.validUntil <= this.now() ||
        subscription.verifiedAt + DAY <= this.now()
      )
        throw new AppError(403, "SUBSCRIPTION_REQUIRED");
      const target = requireValue(
        (await tx.select().from(profiles).where(eq(profiles.id, subscription.profileId)))[0],
      );
      const entitlement = (
        await tx.select().from(entitlements).where(eq(entitlements.profileId, target.id))
      )[0];
      if (!isEntitled(entitlement, this.now())) throw new AppError(403, "SUBSCRIPTION_REQUIRED");
      if (target.userId !== currentUserId) {
        const current = requireValue(
          (await tx.select().from(profiles).where(eq(profiles.userId, currentUserId)))[0],
        );
        const u = requireValue((await tx.select().from(user).where(eq(user.id, currentUserId)))[0]);
        const existing = await tx
          .select({ id: storeSubscriptions.id })
          .from(storeSubscriptions)
          .where(eq(storeSubscriptions.profileId, current.id));
        if (
          u.emailVerified ||
          current.version !== 1 ||
          current.state !== "draft" ||
          existing.length
        )
          throw new AppError(409, "RESTORE_REQUIRES_FRESH_DEVICE_IDENTITY");
        // Only discard the empty bootstrap identity, never merge private data across accounts.
        await tx.delete(user).where(eq(user.id, currentUserId));
      }
      await tx.delete(deviceCredentials).where(eq(deviceCredentials.userId, target.userId));
      await tx.delete(session).where(eq(session.userId, target.userId));
      // Old phones must not keep receiving reminders after the owner moves to a new phone.
      await tx.delete(devices).where(eq(devices.profileId, target.id));
      await tx
        .update(outbox)
        .set({ state: "cancelled", payload: "" })
        .where(
          and(
            eq(outbox.profileId, target.id),
            eq(outbox.kind, "reminder"),
            eq(outbox.state, "pending"),
          ),
        );
      await log(tx, target, "store_device_restored", this.now());
      const result = {
        ...(await this.issue(tx, target.userId)),
        accountToken: target.id,
        userId: target.userId,
      };
      if (operation) await operations.complete(tx, operation, result);
      return result;
    });
  }
  async requestContact(userId: string, email: string, name: string) {
    const u = requireValue((await this.db.select().from(user).where(eq(user.id, userId)))[0]);
    if (u.emailVerified) throw new AppError(409, "CONTACT_ALREADY_VERIFIED");
    const token = randomToken(),
      expiresAt = this.now() + 600_000;
    const vault = new Vault(this.env);
    await atomic(this.db, async (tx) => {
      const values = {
        userId,
        tokenHash: await hash(token),
        email: await vault.seal(email.toLowerCase(), `contact:${userId}`),
        name,
        expiresAt,
      };
      await tx
        .insert(contactVerifications)
        .values(values)
        .onConflictDoUpdate({ target: contactVerifications.userId, set: values });
      await enqueue(
        tx,
        vault,
        "auth",
        `contact:${crypto.randomUUID()}`,
        {
          channel: "email",
          to: email.toLowerCase(),
          template: "contact_verification",
          url: `${this.env.RECIPIENT_WEB_URL}/confirm-contact#${token}`,
          expiresAt,
        },
        this.now(),
      );
    });
  }
  async confirmContact(userId: string, token: string) {
    await atomic(this.db, async (tx) => {
      const pending = (
        await tx
          .select()
          .from(contactVerifications)
          .where(
            and(
              eq(contactVerifications.userId, userId),
              eq(contactVerifications.tokenHash, await hash(token)),
              gt(contactVerifications.expiresAt, this.now()),
            ),
          )
      )[0];
      if (!pending) throw new AppError(400, "INVALID_CONTACT_LINK");
      const email = await new Vault(this.env).open<string>(pending.email, `contact:${userId}`);
      const other = (await tx.select().from(user).where(eq(user.email, email)))[0];
      if (other && other.id !== userId)
        throw new AppError(409, "EMAIL_ALREADY_LINKED_USE_RECOVERY");
      const u = requireValue((await tx.select().from(user).where(eq(user.id, userId)))[0]);
      if (u.emailVerified) throw new AppError(409, "CONTACT_ALREADY_VERIFIED");
      await tx
        .update(user)
        .set({ email, name: pending.name, emailVerified: true, updatedAt: new Date(this.now()) })
        .where(eq(user.id, userId));
      await tx.delete(contactVerifications).where(eq(contactVerifications.userId, userId));
    });
  }
}
