import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { storeSubscriptions, webhookEvents } from "../src/db/schema";
import { googleAccountHash } from "../src/integrations/store-account";
import type { StoreVerifier, VerifiedSubscription } from "../src/integrations/stores";
import { hash } from "../src/lib/crypto";
import { BillingService } from "../src/services/billing";
import { DAY } from "../src/services/switch";
import { fixture, type Fixture } from "./helpers";

let f: Fixture;
let billing: BillingService;
let purchase: VerifiedSubscription;
beforeEach(async () => {
  const verifier: StoreVerifier = {
    verify: async () => purchase,
    restore: async () => purchase,
    appleNotification: async () => ({ id: "unused" }),
    googlePushAuthorization: async () => {},
  };
  f = await fixture(verifier);
  billing = new BillingService(f.db, f.env, verifier, f.now);
});
afterEach(() => f.client.close());

async function initial(hashed = false, ownerVerified = true) {
  const owner = await f.createUser();
  purchase = {
    store: "google",
    reference: "purchase-A",
    accountToken: hashed ? await googleAccountHash(owner.profile.id) : owner.profile.id,
    productId: "basic:annual",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 30 * DAY,
  };
  if (ownerVerified) await billing.verifyPurchase("google", "purchase-A", owner.profile.id);
  else await billing.verify("google", "purchase-A");
  return owner;
}
async function replace(reference: string, linkedReference: string) {
  f.advance(1);
  purchase = { ...purchase, reference, linkedReference };
  // Real RTDN handler with mocked store network: the event body only carries a token.
  f.env.GOOGLE_PACKAGE_NAME = "jp.test.app";
  await billing.googleWebhook("mock-oidc", {
    message: {
      messageId: `${reference}:${f.now()}`,
      data: btoa(
        JSON.stringify({
          packageName: "jp.test.app",
          subscriptionNotification: { purchaseToken: reference },
        }),
      ),
    },
  });
}

for (const hashed of [false, true]) {
  test(`multi-hop replacement restores through the original owner proof (${hashed ? "hashed" : "direct"})`, async () => {
    const owner = await initial(hashed);
    await replace("purchase-B", "purchase-A");
    await replace("purchase-C", "purchase-B");
    const rows = await f.db.select().from(storeSubscriptions);
    expect(rows.filter((row) => row.ownerVerifiedAt !== null)).toHaveLength(1);
    const rootHash = await hash("google:purchase-A");
    expect(rows.find((row) => row.referenceHash === rootHash)!.ownerVerifiedAt).not.toBeNull();
    expect(
      rows
        .filter((row) => row.referenceHash !== rootHash)
        .every((row) => row.ownerVerifiedAt === null),
    ).toBe(true);
    expect(rows.filter((row) => row.linkedReferenceHash !== null)).toHaveLength(2);
    // A later response omitting the edge cannot erase the persisted lineage.
    purchase = { ...purchase, linkedReference: undefined };
    await billing.verify("google", "purchase-C");
    const freshResponse = await f.request("/v1/auth/bootstrap", "POST", {});
    const fresh = (await freshResponse.json()) as { token: string };
    const response = await f.request(
      "/v1/auth/restore",
      "POST",
      { store: "google", purchaseToken: "purchase-C" },
      fresh.token,
    );
    expect(response.status).toBe(200);
    const restored = (await response.json()) as {
      userId: string;
      accountToken: string;
      token: string;
    };
    expect(restored.userId).toBe(owner.id);
    expect(restored.accountToken).toBe(owner.profile.id);
    expect((await f.request("/v1/me", "GET", undefined, owner.token)).status).toBe(401);
    expect((await f.request("/v1/me", "GET", undefined, restored.token)).status).toBe(200);
  });
}

test("webhook-only replacement chains never establish an owner proof", async () => {
  await initial(false, false);
  await replace("purchase-B", "purchase-A");
  await replace("purchase-C", "purchase-B");
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }),
  ).rejects.toThrow("PURCHASE_NOT_REGISTERED");
  expect(
    (await f.db.select().from(storeSubscriptions)).every((row) => row.ownerVerifiedAt === null),
  ).toBe(true);
});

test("self-links, cycles and changed predecessors roll back the event and edge", async () => {
  await initial();
  await expect(replace("purchase-A", "purchase-A")).rejects.toThrow("PURCHASE_CHAIN_INVALID");
  await replace("purchase-B", "purchase-A");
  await replace("purchase-C", "purchase-B");
  await expect(replace("purchase-A", "purchase-C")).rejects.toThrow("PURCHASE_CHAIN_INVALID");
  await expect(replace("purchase-C", "purchase-A")).rejects.toThrow("PURCHASE_CHAIN_INVALID");
  const a = (
    await f.db
      .select()
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.referenceHash, await hash("google:purchase-A")))
  )[0]!;
  expect(a.linkedReferenceHash).toBeNull();
  expect(await f.db.select().from(webhookEvents)).toHaveLength(2);
});

test("unresolved or missing historical edges do not infer ownership from the account identifier", async () => {
  const owner = await initial();
  await replace("purchase-B", "unknown-predecessor");
  await replace("purchase-C", "purchase-B");
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }),
  ).rejects.toThrow("PURCHASE_NOT_REGISTERED");
  // A legacy row with no saved B→A evidence cannot borrow A's unrelated proof.
  await f.db
    .update(storeSubscriptions)
    .set({ linkedReferenceHash: null })
    .where(eq(storeSubscriptions.referenceHash, await hash("google:purchase-B")));
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }),
  ).rejects.toThrow("PURCHASE_NOT_REGISTERED");
  expect(
    (await f.db.select().from(storeSubscriptions)).filter((row) => row.ownerVerifiedAt !== null),
  ).toHaveLength(1);
  expect((await f.service.profile(owner.id)).id).toBe(owner.profile.id);
  // Re-verifying the intermediate purchase at the store supplies the missing evidence.
  purchase = { ...purchase, reference: "purchase-B", linkedReference: "purchase-A" };
  await billing.verify("google", "purchase-B");
  purchase = { ...purchase, reference: "purchase-C", linkedReference: "purchase-B" };
  expect(
    (await billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }))
      .accountToken,
  ).toBe(owner.profile.id);
});

test("a historical ancestor in a different store is rejected even for the same owner", async () => {
  await initial();
  await replace("purchase-B", "purchase-A");
  await replace("purchase-C", "purchase-B");
  await f.db
    .update(storeSubscriptions)
    .set({ store: "apple" })
    .where(eq(storeSubscriptions.referenceHash, await hash("google:purchase-A")));
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }),
  ).rejects.toThrow("PURCHASE_ALREADY_LINKED");
});

test("an ancestor owned by another profile cannot authorize or be replaced by this chain", async () => {
  const owner = await initial();
  await replace("purchase-B", "purchase-A");
  const other = await f.createUser("other@example.jp");
  // Simulate inconsistent historical storage to exercise the traversal's checks, beyond immediate B.
  await f.db
    .update(storeSubscriptions)
    .set({ profileId: other.profile.id })
    .where(eq(storeSubscriptions.referenceHash, await hash("google:purchase-A")));
  await expect(replace("purchase-C", "purchase-B")).rejects.toThrow("PURCHASE_ALREADY_LINKED");
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }),
  ).rejects.toThrow("PURCHASE_ALREADY_LINKED");
  expect(await f.db.select().from(storeSubscriptions)).toHaveLength(2);
  expect((await f.request("/v1/me", "GET", undefined, owner.token)).status).toBe(200);
});

test("cycles already present in historical storage cannot authorize recovery", async () => {
  await initial();
  await replace("purchase-B", "purchase-A");
  await replace("purchase-C", "purchase-B");
  await f.db
    .update(storeSubscriptions)
    .set({ linkedReferenceHash: await hash("google:purchase-C") })
    .where(eq(storeSubscriptions.referenceHash, await hash("google:purchase-A")));
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "purchase-C" }),
  ).rejects.toThrow("PURCHASE_CHAIN_INVALID");
  expect(
    (await f.db.select().from(storeSubscriptions)).filter((row) => row.ownerVerifiedAt !== null),
  ).toHaveLength(1);
});
