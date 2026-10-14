import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import {
  entitlements,
  profiles,
  recipients,
  storeSubscriptions,
  webhookEvents,
} from "../db/schema";
import type { Env } from "../env";
import { hash, Vault } from "../lib/crypto";
import { AppError, requireValue } from "../lib/errors";
import {
  createStoreVerifier,
  type Store,
  type StoreVerifier,
  type VerifiedSubscription,
  type RestorePurchaseProof,
} from "../integrations/stores";
import { storeAccountMatches } from "../integrations/store-account";
import { DAY, invalidate, log, recipientLimit } from "./switch";

async function aggregate(tx: Tx, profileId: string, now: number) {
  const p = requireValue((await tx.select().from(profiles).where(eq(profiles.id, profileId)))[0]);
  const all = await tx
    .select()
    .from(storeSubscriptions)
    .where(eq(storeSubscriptions.profileId, profileId));
  const valid = all.filter(
    (s) => ["active", "grace"].includes(s.status) && s.validUntil > now && s.verifiedAt + DAY > now,
  );
  valid.sort(
    (a, b) =>
      (a.plan === "plus" ? 0 : 1) - (b.plan === "plus" ? 0 : 1) || b.validUntil - a.validUntil,
  );
  const best = valid[0];
  const value = {
    profileId,
    plan: best?.plan ?? ("basic" as const),
    status: best?.status ?? ("expired" as const),
    validUntil: best ? Math.min(best.validUntil, best.verifiedAt + DAY) : now,
    sourceVersion: now,
  };
  await tx
    .insert(entitlements)
    .values(value)
    .onConflictDoUpdate({ target: entitlements.profileId, set: value });
  const count = (
    await tx.select({ id: recipients.id }).from(recipients).where(eq(recipients.profileId, p.id))
  ).length;
  if (
    (!best || count > recipientLimit(best.plan)) &&
    ["active", "grace", "released"].includes(p.state)
  )
    await invalidate(tx, p, "held", now, best ? "recipient_limit" : "entitlement_inactive");
  await log(tx, p, "store_subscription_verified", now);
  return value;
}
export class BillingService {
  private vault: Vault;
  constructor(
    private db: Database,
    private env: Env,
    private verifier: StoreVerifier = createStoreVerifier(env),
    private now: () => number = Date.now,
  ) {
    this.vault = new Vault(env);
  }
  async verify(store: Store, reference: string, expectedProfileId?: string, eventId?: string) {
    const startedAt = this.now();
    const raw = await this.verifier.verify(store, reference, expectedProfileId);
    if (raw.store !== store) throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
    const verified = await this.resolveOwner(raw, expectedProfileId);
    return this.apply(verified, startedAt, eventId);
  }
  async verifyPurchase(store: Store, reference: string, profileId: string) {
    const startedAt = this.now();
    const raw = await this.verifier.verify(store, reference, profileId);
    if (raw.store !== store) throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
    const verified = await this.resolveOwner(raw, profileId);
    return this.apply(verified, startedAt, undefined, true);
  }
  async verifyRestoration(proof: RestorePurchaseProof) {
    const startedAt = this.now();
    const verified = await this.verifier.restore(proof);
    if (verified.store !== proof.store) throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
    const refs = [
      verified.reference,
      ...(verified.linkedReference ? [verified.linkedReference] : []),
    ];
    const hashes = await Promise.all(refs.map((ref) => hash(`${verified.store}:${ref}`)));
    const known = await this.db
      .select()
      .from(storeSubscriptions)
      .where(
        and(
          eq(storeSubscriptions.store, verified.store),
          inArray(storeSubscriptions.referenceHash, hashes),
        ),
      );
    // Recover the owner only from the registered purchase proof, never from a raw/hash account ID alone.
    const profileId = known[0]?.profileId;
    if (
      !profileId ||
      known.some((s) => s.profileId !== profileId) ||
      !(await storeAccountMatches(verified.store, verified.accountToken, profileId))
    )
      throw new AppError(403, "PURCHASE_NOT_REGISTERED");
    const normalized = { ...verified, accountToken: profileId };
    // Check the persisted replacement lineage in the write transaction before accepting recovery.
    await this.apply(normalized, startedAt, undefined, true, true);
    if (!["active", "grace"].includes(verified.status) || verified.validUntil <= this.now())
      throw new AppError(403, "SUBSCRIPTION_REQUIRED");
    return normalized;
  }
  private async resolveOwner(verified: VerifiedSubscription, expectedProfileId?: string) {
    if (expectedProfileId) {
      if (!(await storeAccountMatches(verified.store, verified.accountToken, expectedProfileId)))
        throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
      return { ...verified, accountToken: expectedProfileId };
    }
    if (verified.store === "apple") return verified;
    const references = [
      verified.reference,
      ...(verified.linkedReference ? [verified.linkedReference] : []),
    ];
    const hashes = await Promise.all(references.map((ref) => hash(`google:${ref}`)));
    const known = await this.db
      .select()
      .from(storeSubscriptions)
      .where(
        and(
          eq(storeSubscriptions.store, "google"),
          inArray(storeSubscriptions.referenceHash, hashes),
        ),
      );
    const profileId = known[0]?.profileId;
    if (profileId) {
      if (
        known.some((s) => s.profileId !== profileId) ||
        !(await storeAccountMatches("google", verified.accountToken, profileId))
      )
        throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
      return { ...verified, accountToken: profileId };
    }
    // Preserve existing direct-ID webhooks. An unknown hash cannot locate an owner;
    // the authenticated first purchase verification must establish its binding first.
    const direct = (
      await this.db
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, verified.accountToken))
    )[0];
    if (!direct) throw new AppError(403, "PURCHASE_NOT_REGISTERED");
    return verified;
  }
  private async apply(
    verified: VerifiedSubscription,
    startedAt: number,
    eventId?: string,
    ownerVerified = false,
    requireRegisteredLineage = false,
  ) {
    const referenceHash = await hash(`${verified.store}:${verified.reference}`);
    const linkedHash = verified.linkedReference
      ? await hash(`${verified.store}:${verified.linkedReference}`)
      : undefined;
    return this.db.transaction(
      async (tx) => {
        const p = requireValue(
          (await tx.select().from(profiles).where(eq(profiles.id, verified.accountToken)))[0],
          "PURCHASE_ACCOUNT_NOT_FOUND",
        );
        if (eventId) {
          const applied = await tx
            .insert(webhookEvents)
            .values({ id: eventId, createdAt: startedAt })
            .onConflictDoNothing()
            .returning();
          if (!applied.length) return { received: true };
        }
        const current = (
          await tx
            .select()
            .from(storeSubscriptions)
            .where(eq(storeSubscriptions.referenceHash, referenceHash))
        )[0];
        if (current && (current.profileId !== p.id || current.store !== verified.store))
          throw new AppError(403, "PURCHASE_ALREADY_LINKED");
        // Store-issued replacement edges are immutable once observed. Missing edges in a
        // later response must not erase the evidence needed to recover through older purchases.
        if (
          linkedHash &&
          current?.linkedReferenceHash &&
          linkedHash !== current.linkedReferenceHash
        )
          throw new AppError(403, "PURCHASE_CHAIN_INVALID");
        const predecessor = linkedHash ?? current?.linkedReferenceHash ?? null;
        await this.checkLineage(
          tx,
          verified.store,
          p.id,
          referenceHash,
          predecessor,
          current?.ownerVerifiedAt !== null && current?.ownerVerifiedAt !== undefined,
          requireRegisteredLineage,
        );
        // Out-of-order network responses cannot overwrite a newer verification.
        if (current && current.verifiedAt > startedAt) {
          // Keep newer store state, but retain proof of the authenticated owner's original binding.
          if (ownerVerified && current.ownerVerifiedAt === null)
            await tx
              .update(storeSubscriptions)
              .set({ ownerVerifiedAt: startedAt })
              .where(eq(storeSubscriptions.id, current.id));
          return { received: true };
        }
        const id = current?.id ?? crypto.randomUUID();
        const values = {
          id,
          profileId: p.id,
          store: verified.store,
          referenceHash,
          linkedReferenceHash: predecessor,
          reference: await this.vault.seal(verified.reference, `subscription:${id}`),
          productId: verified.productId,
          plan: verified.plan,
          status: verified.status,
          validUntil: verified.validUntil,
          verifiedAt: startedAt,
          nextCheckAt: startedAt + 6 * 60 * 60_000,
          ...(ownerVerified ? { ownerVerifiedAt: startedAt } : {}),
        };
        await tx
          .insert(storeSubscriptions)
          .values(values)
          .onConflictDoUpdate({ target: storeSubscriptions.referenceHash, set: values });
        if (linkedHash) {
          const prior = (
            await tx
              .select()
              .from(storeSubscriptions)
              .where(eq(storeSubscriptions.referenceHash, linkedHash))
          )[0];
          if (prior && prior.profileId !== p.id) throw new AppError(403, "PURCHASE_ALREADY_LINKED");
          if (prior)
            await tx
              .update(storeSubscriptions)
              .set({ status: "expired", validUntil: startedAt, verifiedAt: startedAt })
              .where(eq(storeSubscriptions.id, prior.id));
        }
        return aggregate(tx, p.id, startedAt);
      },
      { behavior: "immediate" },
    );
  }
  private async checkLineage(
    tx: Tx,
    store: Store,
    profileId: string,
    referenceHash: string,
    predecessor: string | null,
    hasOwnerProof: boolean,
    requireRegistered: boolean,
  ) {
    const seen = new Set([referenceHash]);
    let next = predecessor;
    while (next) {
      if (seen.has(next) || seen.size >= 256) throw new AppError(403, "PURCHASE_CHAIN_INVALID");
      seen.add(next);
      const prior = (
        await tx.select().from(storeSubscriptions).where(eq(storeSubscriptions.referenceHash, next))
      )[0];
      if (!prior) {
        // Preserve an unresolved store-issued edge, but it cannot authorize recovery.
        if (requireRegistered) throw new AppError(403, "PURCHASE_NOT_REGISTERED");
        return;
      }
      if (prior.profileId !== profileId || prior.store !== store)
        throw new AppError(403, "PURCHASE_ALREADY_LINKED");
      hasOwnerProof ||= prior.ownerVerifiedAt !== null;
      next = prior.linkedReferenceHash;
    }
    if (requireRegistered && !hasOwnerProof) throw new AppError(403, "PURCHASE_NOT_REGISTERED");
  }
  async appleWebhook(signedPayload: string) {
    const notice = await this.verifier.appleNotification(signedPayload);
    if (!notice.reference) return;
    // Refetch current status. A signed historical DID_RENEW must not restore a refunded entitlement.
    await this.verify("apple", notice.reference, notice.accountToken, `apple:${notice.id}`);
  }
  async googleWebhook(token: string, body: unknown) {
    await this.verifier.googlePushAuthorization(token);
    const { z } = await import("zod");
    const message = z
      .object({ message: z.object({ messageId: z.string(), data: z.string() }) })
      .parse(body).message;
    const event = z
      .object({
        packageName: z.string(),
        subscriptionNotification: z.object({ purchaseToken: z.string() }).optional(),
        testNotification: z.unknown().optional(),
      })
      .parse(JSON.parse(atob(message.data)));
    if (event.packageName !== this.env.GOOGLE_PACKAGE_NAME)
      throw new AppError(400, "PACKAGE_MISMATCH");
    if (!event.subscriptionNotification) return;
    // RTDN is a trigger, not an entitlement. Query subscriptionsv2 for the authoritative state.
    await this.verify(
      "google",
      event.subscriptionNotification.purchaseToken,
      undefined,
      `google:${message.messageId}`,
    );
  }
  async refreshDue() {
    const now = this.now();
    const due = await this.db
      .select()
      .from(storeSubscriptions)
      .where(
        and(
          lte(storeSubscriptions.nextCheckAt, now),
          inArray(storeSubscriptions.status, ["active", "grace"]),
        ),
      )
      .orderBy(storeSubscriptions.nextCheckAt)
      .limit(10);
    for (const s of due) {
      try {
        await this.verify(
          s.store,
          await this.vault.open<string>(s.reference, `subscription:${s.id}`),
          s.profileId,
        );
      } catch {
        await this.db
          .update(storeSubscriptions)
          .set({ nextCheckAt: now + 300_000 })
          .where(eq(storeSubscriptions.id, s.id));
      }
    }
  }
}
