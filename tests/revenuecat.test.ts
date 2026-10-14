import { expect, test } from "bun:test";
import { sign } from "../src/lib/crypto";
import {
  verifyRevenueCatAppleHint,
  verifyRevenueCatWebhook,
  type RevenueCatWebhookConfig,
} from "../src/integrations/revenuecat";
import type { StoreVerifier } from "../src/integrations/stores";
const now = 1_791_936_000_000;
const config: RevenueCatWebhookConfig = {
  authorization: "Bearer mock-revenuecat-webhook",
  signingSecret: "mock-signing-secret",
  appId: "test-app",
  environment: "SANDBOX",
};
const event = {
  id: "event-1",
  type: "INITIAL_PURCHASE",
  app_id: config.appId,
  environment: "SANDBOX",
  app_user_id: "owner-profile",
  transaction_id: "200000001",
  store: "APP_STORE",
  is_family_share: false,
  aliases: ["untrusted-alias"],
  subscriber_attributes: { secret: "must-not-forward" },
};
async function signed(value = event, timestamp = Math.floor(now / 1000)) {
  const raw = JSON.stringify({ api_version: "1.0", event: value });
  const mac = Buffer.from(
    await sign(config.signingSecret, `${timestamp}.${raw}`),
    "base64",
  ).toString("hex");
  return {
    raw,
    headers: new Headers({
      Authorization: config.authorization,
      "X-RevenueCat-Webhook-Signature": `t=${timestamp},v1=${mac}`,
    }),
  };
}

test("authenticated RevenueCat evidence can only locate an Apple transaction; store ownership is reverified", async () => {
  const { raw, headers } = await signed();
  const result = await verifyRevenueCatWebhook(raw, headers, config, now);
  expect(result.kind).toBe("apple_transaction_hint");
  expect(JSON.stringify(result)).not.toContain("must-not-forward");
  if (result.kind !== "apple_transaction_hint") throw new Error("Expected hint");
  let calls = 0;
  const verifier = {
    verify: async (store, transactionId, accountToken) => {
      calls++;
      expect(store).toBe("apple");
      expect(transactionId).toBe("200000001");
      expect(accountToken).toBe("owner-profile");
      return {
        store: "apple",
        accountToken: "owner-profile",
        reference: "original",
        productId: "annual",
        plan: "basic",
        status: "expired",
        validUntil: now - 1,
      };
    },
  } as StoreVerifier;
  expect((await verifyRevenueCatAppleHint(result.hint, "owner-profile", verifier)).status).toBe(
    "expired",
  );
  await expect(verifyRevenueCatAppleHint(result.hint, "untrusted-alias", verifier)).rejects.toThrow(
    "PURCHASE_ACCOUNT_MISMATCH",
  );
  expect(calls).toBe(1);
  const wrongStoreOwner = {
    verify: async () => ({ store: "apple", accountToken: "another-owner" }),
  } as unknown as StoreVerifier;
  await expect(
    verifyRevenueCatAppleHint(result.hint, "owner-profile", wrongStoreOwner),
  ).rejects.toThrow("PURCHASE_ACCOUNT_MISMATCH");
});

test("forged, stale, changed-body, wrong-app and wrong-environment events are rejected", async () => {
  const good = await signed();
  await expect(verifyRevenueCatWebhook(good.raw, new Headers(), config, now)).rejects.toThrow(
    "INVALID_REVENUECAT_SIGNATURE",
  );
  await expect(verifyRevenueCatWebhook(good.raw + " ", good.headers, config, now)).rejects.toThrow(
    "INVALID_REVENUECAT_SIGNATURE",
  );
  const stale = await signed(event, Math.floor(now / 1000) - 301);
  await expect(verifyRevenueCatWebhook(stale.raw, stale.headers, config, now)).rejects.toThrow(
    "INVALID_REVENUECAT_SIGNATURE",
  );
  await expect(
    verifyRevenueCatWebhook(good.raw, good.headers, { ...config, appId: "other-app" }, now),
  ).rejects.toThrow("REVENUECAT_APP_MISMATCH");
  await expect(
    verifyRevenueCatWebhook(good.raw, good.headers, { ...config, environment: "PRODUCTION" }, now),
  ).rejects.toThrow("REVENUECAT_APP_MISMATCH");
});

test("transfers, family sharing, test and temporary grants do not become owner proofs; Google order ID is never a token", async () => {
  for (const change of [
    { type: "TRANSFER" },
    { is_family_share: true },
    { type: "TEST" },
    { type: "TEMPORARY_ENTITLEMENT_GRANT" },
  ]) {
    const { raw, headers } = await signed({ ...event, ...change });
    expect((await verifyRevenueCatWebhook(raw, headers, config, now)).kind).toBe("ignored");
  }
  const google = await signed({ ...event, store: "PLAY_STORE", transaction_id: "GPA.123456" });
  expect(await verifyRevenueCatWebhook(google.raw, google.headers, config, now)).toEqual({
    kind: "requires_store_proof",
    eventId: event.id,
  });
});
