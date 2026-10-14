import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import { fixture, type Fixture } from "./helpers";
import { renderNotice } from "../src/emails/notice";
import {
  notificationTransport,
  verifyResendWebhook,
  processResendWebhook,
  pollExpoReceipts,
  type HttpClient,
} from "../src/integrations/notifications";
import {
  createStoreVerifier,
  normalizeGooglePurchase,
  type StoreVerifier,
  type VerifiedSubscription,
} from "../src/integrations/stores";
import { BillingService } from "../src/services/billing";
import { googleAccountHash, storeAccountMatches } from "../src/integrations/store-account";
import { DAY } from "../src/services/switch";
import { entitlements, outbox, storeSubscriptions, devices } from "../src/db/schema";
import { enqueue, gatewayTransport } from "../src/services/notifications";
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => f.client.close());
const fakeHttp = (handler: (url: string, init?: RequestInit) => Promise<Response>) =>
  handler as HttpClient;

test("phase one cancels queued SMS and blocks both transports even when configured", async () => {
  const notice = { channel: "sms", to: "+819012345678", template: "final" } as const;
  const id = await enqueue(f.db, f.service.vault, "final", "legacy-sms", notice, f.now());
  await f.flush();
  const job = (await f.db.select().from(outbox).where(eq(outbox.id, id)))[0]!;
  expect(job.state).toBe("cancelled");
  expect(job.payload).toBe("");
  expect(f.captured).toHaveLength(0);
  expect(await gatewayTransport(f.env)(id, notice)).toEqual({ state: "failed" });
  let calls = 0;
  const native = notificationTransport(
    { ...f.env, NOTIFICATION_DRIVER: "native" },
    fakeHttp(async () => {
      calls++;
      return Response.json({ id: "unexpected" });
    }),
  );
  expect(await native(id, notice)).toEqual({ state: "failed" });
  expect(calls).toBe(0);
});

test("React Email escapes untrusted display names and renders both formats", async () => {
  const mail = await renderNotice({
    channel: "email",
    to: "a@example.jp",
    template: "final",
    senderName: "<script>alert(1)</script>",
    url: "https://example.jp/receive#token",
  });
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.html).not.toContain("<script>alert");
  expect(mail.text).toContain("死亡を確認したものではありません");
  expect(mail.html).toContain("https://example.jp/receive#token");
});
test("Resend sends one recipient, no confidential body, with stable idempotency", async () => {
  const transport = notificationTransport(
    {
      ...f.env,
      NOTIFICATION_DRIVER: "native",
      RESEND_API_KEY: "test",
      EMAIL_FROM: "App <app@example.jp>",
    },
    fakeHttp(async (url, init) => {
      expect(url).toBe("https://api.resend.com/emails");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("outbox-id");
      const body = JSON.parse(String(init?.body));
      expect(body.to).toEqual(["receiver@example.jp"]);
      expect(body.tags).toEqual([{ name: "outbox_id", value: "outbox-id" }]);
      expect(body.html).toContain("テスト");
      return Response.json({ id: "resend-id" });
    }),
  );
  expect(
    await transport("outbox-id", {
      channel: "email",
      to: "receiver@example.jp",
      template: "self_test",
    }),
  ).toEqual({ state: "accepted", providerId: "resend:resend-id" });
});
test("Expo successful ticket is accepted, not a user check-in", async () => {
  const { owner } = await f.ready();
  const previous = (await f.service.status(owner.id)).lastCheckInAt;
  const transport = notificationTransport(
    { ...f.env, NOTIFICATION_DRIVER: "native" },
    fakeHttp(async (url, init) => {
      expect(url).toBe("https://exp.host/--/api/v2/push/send");
      const body = JSON.parse(String(init?.body));
      expect(body.data).toEqual({ action: "check-in" });
      return Response.json({ data: { status: "ok", id: "ticket" } });
    }),
  );
  expect(
    await transport("id", { channel: "push", to: "ExpoPushToken[test]", template: "reminder" }),
  ).toEqual({ state: "accepted", providerId: "expo:ticket" });
  expect((await f.service.status(owner.id)).lastCheckInAt).toBe(previous);
});
test("Expo invalid-device receipt unregisters only the matching device", async () => {
  const owner = await f.createUser();
  const d = await f.service.addDevice(owner.id, "ExpoPushToken[test]");
  const id = await enqueue(
    f.db,
    f.service.vault,
    "reminder",
    "receipt-test",
    { channel: "push", to: "ExpoPushToken[test]", template: "reminder" },
    f.now(),
    { profileId: owner.profile.id, deviceId: d.id },
  );
  await f.db
    .update(outbox)
    .set({ state: "accepted", providerId: "expo:ticket", claimedAt: f.now() - 16 * 60_000 })
    .where(eq(outbox.id, id));
  await pollExpoReceipts(
    f.db,
    { ...f.env, NOTIFICATION_DRIVER: "native" },
    fakeHttp(async () =>
      Response.json({
        data: { ticket: { status: "error", details: { error: "DeviceNotRegistered" } } },
      }),
    ),
    f.now(),
  );
  expect((await f.db.select().from(devices)).length).toBe(0);
});
async function svixHeaders(raw: string, secret: Uint8Array, now: number) {
  const timestamp = String(Math.floor(now / 1000)),
    id = "msg_event_1";
  const key = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${raw}`),
  );
  return new Headers({
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${Buffer.from(signature).toString("base64")}`,
  });
}
test("Resend validates raw-body signature and handles duplicate bounced events", async () => {
  const secret = new Uint8Array(32).fill(91);
  const env = {
    ...f.env,
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from(secret).toString("base64")}`,
  };
  const id = await enqueue(
    f.db,
    f.service.vault,
    "auth",
    "auth-test",
    { channel: "email", to: "a@example.jp", template: "magic_link" },
    f.now(),
  );
  await f.db
    .update(outbox)
    .set({ state: "accepted", providerId: "resend:abc" })
    .where(eq(outbox.id, id));
  const raw = JSON.stringify({ type: "email.bounced", data: { email_id: "abc" } });
  const headers = await svixHeaders(raw, secret, f.now());
  await expect(verifyResendWebhook(env, `${raw} `, headers, f.now())).rejects.toThrow(
    "INVALID_SIGNATURE",
  );
  await processResendWebhook(f.db, env, raw, headers, f.now());
  await processResendWebhook(f.db, env, raw, headers, f.now());
  expect((await f.db.select().from(outbox).where(eq(outbox.id, id)))[0]!.state).toBe("failed");
});
function googlePurchase(accountToken: string) {
  return {
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    regionCode: "JP",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: accountToken },
    lineItems: [
      {
        productId: "basic",
        offerDetails: { basePlanId: "annual" },
        expiryTime: new Date(f.now() + 365 * DAY).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
  };
}
test("Google free trial and cancelled renewal follow the store expiry, without granting extra trial days", () => {
  const env = { ...f.env, STORE_PRODUCTS: JSON.stringify({ google: { "basic:annual": "basic" } }) };
  const trial = googlePurchase("profile");
  const expiry = f.now() + 28 * DAY;
  trial.lineItems[0]!.expiryTime = new Date(expiry).toISOString();
  expect(normalizeGooglePurchase(trial, "token", env, f.now()).validUntil).toBe(expiry);
  trial.subscriptionState = "SUBSCRIPTION_STATE_CANCELED";
  trial.lineItems[0]!.autoRenewingPlan.autoRenewEnabled = false;
  expect(normalizeGooglePurchase(trial, "token", env, expiry - 1).status).toBe("active");
  expect(normalizeGooglePurchase(trial, "token", env, expiry).status).toBe("expired");
});
test("Google enforces Japan, product/base-plan mapping, test environment and expiry", () => {
  const env = { ...f.env, STORE_PRODUCTS: JSON.stringify({ google: { "basic:annual": "basic" } }) };
  const purchase = googlePurchase("profile");
  expect(normalizeGooglePurchase(purchase, "token", env).status).toBe("active");
  expect(
    normalizeGooglePurchase(
      { ...purchase, subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" },
      "token",
      env,
    ).status,
  ).toBe("grace");
  expect(
    normalizeGooglePurchase(
      { ...purchase, subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" },
      "token",
      env,
    ).status,
  ).toBe("expired");
  expect(() => normalizeGooglePurchase({ ...purchase, regionCode: "US" }, "token", env)).toThrow(
    "JAPAN_PURCHASE_REQUIRED",
  );
  expect(() =>
    normalizeGooglePurchase({ ...purchase, testPurchase: {} }, "token", {
      ...env,
      APP_ENV: "production",
    }),
  ).toThrow("TEST_PURCHASE_REJECTED");
  expect(() =>
    normalizeGooglePurchase(purchase, "token", { ...env, STORE_PRODUCTS: "{}" }),
  ).toThrow("UNSUPPORTED_PRODUCT");
});
test("Google verifier uses server OAuth/API and acknowledges a bound purchase", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const env = {
    ...f.env,
    GOOGLE_PRIVATE_KEY: await exportPKCS8(privateKey),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "billing@example.iam.gserviceaccount.com",
    GOOGLE_PACKAGE_NAME: "jp.example.app",
    STORE_PRODUCTS: JSON.stringify({ google: { "basic:annual": "basic" } }),
  };
  const calls: string[] = [];
  let account = "bound-user";
  const verifier = createStoreVerifier(
    env,
    fakeHttp(async (url) => {
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({ access_token: "oauth-token" });
      if (url.endsWith(":acknowledge")) return new Response(null, { status: 204 });
      return Response.json({
        ...googlePurchase(account),
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      });
    }),
  );
  await expect(verifier.verify("google", "purchase-token", "attacker")).rejects.toThrow(
    "PURCHASE_ACCOUNT_MISMATCH",
  );
  expect(calls.some((url) => url.endsWith(":acknowledge"))).toBe(false);
  expect((await verifier.verify("google", "purchase-token", "bound-user")).plan).toBe("basic");
  expect(
    calls.some((url) => url.endsWith("/subscriptions/basic/tokens/purchase-token:acknowledge")),
  ).toBe(true);
  calls.length = 0;
  account = await googleAccountHash("bound-user");
  await expect(verifier.verify("google", "purchase-token", "attacker")).rejects.toThrow(
    "PURCHASE_ACCOUNT_MISMATCH",
  );
  expect(calls.some((url) => url.endsWith(":acknowledge"))).toBe(false);
  expect((await verifier.verify("google", "purchase-token", "bound-user")).accountToken).toBe(
    account,
  );
  expect(calls.some((url) => url.endsWith(":acknowledge"))).toBe(true);
});
function stubVerifier(get: () => VerifiedSubscription): StoreVerifier {
  return {
    verify: async () => get(),
    restore: async () => get(),
    appleNotification: async () => ({ id: "signed-event", reference: "original" }),
    googlePushAuthorization: async () => {},
  };
}
test("hashed Google webhook ownership needs registered references and never grants restoration proof", async () => {
  expect(await googleAccountHash("abc")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  const owner = await f.createUser();
  const other = await f.createUser("other@example.jp");
  const hashed = await googleAccountHash(owner.profile.id);
  expect(await storeAccountMatches("apple", hashed, owner.profile.id)).toBe(false);
  expect(await storeAccountMatches("google", hashed.toUpperCase(), owner.profile.id)).toBe(false);
  expect(await storeAccountMatches("google", hashed.replace(/=+$/, ""), owner.profile.id)).toBe(
    false,
  );
  let verified: VerifiedSubscription = {
    store: "google",
    accountToken: hashed,
    reference: "rc-current",
    productId: "basic:annual",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 30 * DAY,
  };
  const billing = new BillingService(
    f.db,
    f.env,
    stubVerifier(() => verified),
    f.now,
  );
  await expect(billing.verify("google", verified.reference)).rejects.toThrow(
    "PURCHASE_NOT_REGISTERED",
  );
  expect(await f.db.select().from(storeSubscriptions)).toHaveLength(0);
  await billing.verifyPurchase("google", verified.reference, owner.profile.id);
  const registered = (await f.db.select().from(storeSubscriptions))[0]!;
  expect(registered.profileId).toBe(owner.profile.id);
  expect(registered.ownerVerifiedAt).toBe(f.now());
  f.advance(1);
  verified = { ...verified, reference: "rc-next", linkedReference: "rc-current" };
  await billing.verify("google", verified.reference, undefined, "google:rc-event");
  const rows = await f.db.select().from(storeSubscriptions);
  expect(rows.every((row) => row.profileId === owner.profile.id)).toBe(true);
  expect(rows.filter((row) => row.ownerVerifiedAt !== null)).toHaveLength(1);
  verified = { ...verified, accountToken: await googleAccountHash(other.profile.id) };
  await expect(billing.verify("google", verified.reference)).rejects.toThrow(
    "PURCHASE_ACCOUNT_MISMATCH",
  );
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: verified.reference }),
  ).rejects.toThrow("PURCHASE_NOT_REGISTERED");
  expect(
    (await f.db.select().from(entitlements)).every((row) => row.profileId === owner.profile.id),
  ).toBe(true);
});

test("legacy Google direct-ID notifications remain readable but cannot alone establish recovery", async () => {
  const owner = await f.createUser();
  const verified: VerifiedSubscription = {
    store: "google",
    accountToken: owner.profile.id,
    reference: "legacy",
    productId: "basic:annual",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 30 * DAY,
  };
  const billing = new BillingService(
    f.db,
    f.env,
    stubVerifier(() => verified),
    f.now,
  );
  await billing.verify("google", "legacy");
  expect((await f.db.select().from(storeSubscriptions))[0]!.ownerVerifiedAt).toBeNull();
  await expect(
    billing.verifyRestoration({ store: "google", purchaseToken: "legacy" }),
  ).rejects.toThrow("PURCHASE_NOT_REGISTERED");
});
test("store entitlement is account-bound, encrypted, and expires if refresh stops", async () => {
  const owner = await f.createUser();
  const verified: VerifiedSubscription = {
    store: "apple",
    accountToken: owner.profile.id,
    reference: "original",
    productId: "jp.basic.annual",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 365 * DAY,
  };
  const billing = new BillingService(
    f.db,
    f.env,
    stubVerifier(() => verified),
    f.now,
  );
  await expect(billing.verify("apple", "transaction", "another-profile")).rejects.toThrow(
    "PURCHASE_ACCOUNT_MISMATCH",
  );
  await billing.verify("apple", "transaction", owner.profile.id);
  const row = (await f.db.select().from(storeSubscriptions))[0]!;
  expect(row.reference).not.toBe("original");
  expect((await f.db.select().from(entitlements))[0]!.validUntil).toBe(f.now() + DAY);
  verified.status = "revoked";
  f.advance(1);
  await billing.appleWebhook("verified-notification");
  expect((await f.db.select().from(entitlements))[0]!.status).toBe("expired");
});
test("Google RTDN is verified and refetched rather than trusting notification type", async () => {
  const owner = await f.createUser();
  f.env.GOOGLE_PACKAGE_NAME = "jp.example.app";
  let authorized = false,
    fetched = false;
  const verifier = stubVerifier(() => ({
    store: "google",
    accountToken: owner.profile.id,
    reference: "token",
    productId: "basic:annual",
    plan: "basic",
    status: "expired",
    validUntil: f.now() - 1,
  }));
  verifier.googlePushAuthorization = async (token) => {
    if (token !== "signed-id-token") throw new Error("invalid");
    authorized = true;
  };
  const original = verifier.verify;
  verifier.verify = async (...args) => {
    fetched = true;
    return original(...args);
  };
  const billing = new BillingService(f.db, f.env, verifier, f.now);
  const body = {
    message: {
      messageId: "event",
      data: btoa(
        JSON.stringify({
          packageName: "jp.example.app",
          subscriptionNotification: { purchaseToken: "token", notificationType: 2 },
        }),
      ),
    },
  };
  await expect(billing.googleWebhook("forged", body)).rejects.toThrow();
  await billing.googleWebhook("signed-id-token", body);
  expect(authorized && fetched).toBe(true);
  expect((await f.db.select().from(entitlements))[0]!.status).toBe("expired");
});
test("production verifier rejects an unsigned Google identity token", async () => {
  const verifier = createStoreVerifier({
    ...f.env,
    GOOGLE_PUBSUB_AUDIENCE: "https://api.example.jp/webhooks/google",
    GOOGLE_PUBSUB_EMAIL: "push@example.iam.gserviceaccount.com",
  });
  await expect(verifier.googlePushAuthorization("not-a-jwt")).rejects.toThrow(
    "INVALID_GOOGLE_SIGNATURE",
  );
});

test("Apple restore verifies the supplied proof, rejects family sharing, and refetches current status", async () => {
  const { SignedDataVerifier } = await import("@apple/app-store-server-library");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const env = {
    ...f.env,
    APPLE_ROOT_CERTIFICATES: JSON.stringify([
      Buffer.from(await Bun.file("tests/fixtures/AppleRootCA-G3.cer").arrayBuffer()).toString(
        "base64",
      ),
    ]),
    APPLE_BUNDLE_ID: "jp.example.app",
    APPLE_APP_ID: "123456789",
    APPLE_PRIVATE_KEY: await exportPKCS8(privateKey),
    APPLE_KEY_ID: "test-key",
    APPLE_ISSUER_ID: "test-issuer",
    STORE_PRODUCTS: JSON.stringify({ apple: { "jp.basic.annual": "basic" } }),
  };
  let owner = "PURCHASED",
    status = 1,
    serverAccount = "profile",
    requests = 0;
  // Signature verification is the boundary double here; forged signatures are tested in real workerd.
  const decoder = spyOn(
    SignedDataVerifier.prototype,
    "verifyAndDecodeTransaction",
  ).mockImplementation(async (jws: string) => {
    if (!["client-proof", "server-proof"].includes(jws)) throw new Error("Invalid signature");
    return {
      originalTransactionId: "1234",
      appAccountToken: jws === "client-proof" ? "profile" : serverAccount,
      productId: "jp.basic.annual",
      type: "Auto-Renewable Subscription",
      storefront: "JPN",
      inAppOwnershipType: owner,
      expiresDate: f.now() + 30 * DAY,
    };
  });
  try {
    const verifier = createStoreVerifier(
      env,
      fakeHttp(async (url) => {
        requests++;
        expect(url).toBe("https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/1234");
        return Response.json({
          data: [
            {
              lastTransactions: [
                { status, originalTransactionId: "1234", signedTransactionInfo: "server-proof" },
              ],
            },
          ],
        });
      }),
    );
    expect(
      (await verifier.restore({ store: "apple", signedTransaction: "client-proof" })).status,
    ).toBe("active");
    owner = "FAMILY_SHARED";
    await expect(
      verifier.restore({ store: "apple", signedTransaction: "client-proof" }),
    ).rejects.toThrow("PURCHASE_OWNER_REQUIRED");
    expect(requests).toBe(1);
    owner = "PURCHASED";
    status = 5;
    expect(
      (await verifier.restore({ store: "apple", signedTransaction: "client-proof" })).status,
    ).toBe("revoked");
    serverAccount = "another-profile";
    await expect(
      verifier.restore({ store: "apple", signedTransaction: "client-proof" }),
    ).rejects.toThrow("PURCHASE_ACCOUNT_MISMATCH");
    await expect(verifier.restore({ store: "apple", signedTransaction: "forged" })).rejects.toThrow(
      "INVALID_APPLE_SIGNATURE",
    );
  } finally {
    decoder.mockRestore();
  }
});
