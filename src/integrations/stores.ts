import type { SignedDataVerifier } from "@apple/app-store-server-library";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { Env } from "../env";
import { AppError } from "../lib/errors";
import type { HttpClient } from "./notifications";

export type Store = "apple" | "google";
export type RestorePurchaseProof =
  | { store: "apple"; signedTransaction: string }
  | { store: "google"; purchaseToken: string };
export interface VerifiedSubscription {
  store: Store;
  accountToken: string;
  reference: string;
  linkedReference?: string;
  productId: string;
  plan: "basic" | "plus";
  status: "active" | "grace" | "expired" | "revoked";
  validUntil: number;
}
export interface StoreVerifier {
  restore(proof: RestorePurchaseProof): Promise<VerifiedSubscription>;
  verify(
    store: Store,
    reference: string,
    expectedAccountToken?: string,
  ): Promise<VerifiedSubscription>;
  appleNotification(
    payload: string,
  ): Promise<{ id: string; reference?: string; accountToken?: string }>;
  googlePushAuthorization(token: string): Promise<void>;
}
export const productMapSchema = z.object({
  apple: z.record(z.string(), z.enum(["basic", "plus"])).default({}),
  google: z.record(z.string(), z.enum(["basic", "plus"])).default({}),
});
export function productMap(env: Env) {
  return productMapSchema.parse(JSON.parse(env.STORE_PRODUCTS ?? "{}"));
}
function required(value: string | undefined, code: string) {
  if (!value) throw new AppError(503, code);
  return value;
}
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const googlePurchaseSchema = z.object({
  subscriptionState: z.string(),
  regionCode: z.string(),
  testPurchase: z.unknown().optional(),
  acknowledgementState: z.string(),
  linkedPurchaseToken: z.string().optional(),
  externalAccountIdentifiers: z.object({ obfuscatedExternalAccountId: z.string() }),
  lineItems: z
    .array(
      z.object({
        productId: z.string(),
        expiryTime: z.string(),
        offerDetails: z.object({ basePlanId: z.string() }),
        autoRenewingPlan: z.object({ autoRenewEnabled: z.boolean().optional() }).optional(),
      }),
    )
    .min(1),
});
export function normalizeGooglePurchase(
  raw: unknown,
  reference: string,
  env: Env,
  now = Date.now(),
): VerifiedSubscription {
  const data = googlePurchaseSchema.parse(raw);
  if (data.regionCode !== "JP") throw new AppError(422, "JAPAN_PURCHASE_REQUIRED");
  if (env.APP_ENV === "production" && data.testPurchase !== undefined)
    throw new AppError(422, "TEST_PURCHASE_REJECTED");
  const products = productMap(env).google;
  const candidates = data.lineItems.filter(
    (item) =>
      item.autoRenewingPlan &&
      products[`${item.productId}:${item.offerDetails.basePlanId}`] &&
      Number.isFinite(Date.parse(item.expiryTime)),
  );
  if (!candidates.length) throw new AppError(422, "UNSUPPORTED_PRODUCT");
  const line = candidates.sort((a, b) => Date.parse(b.expiryTime) - Date.parse(a.expiryTime))[0]!;
  const validUntil = Date.parse(line.expiryTime);
  const active = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_CANCELED"].includes(
    data.subscriptionState,
  );
  const grace = data.subscriptionState === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
  return {
    store: "google",
    accountToken: data.externalAccountIdentifiers.obfuscatedExternalAccountId,
    reference,
    linkedReference: data.linkedPurchaseToken,
    productId: `${line.productId}:${line.offerDetails.basePlanId}`,
    plan: products[`${line.productId}:${line.offerDetails.basePlanId}`]!,
    status: validUntil <= now ? "expired" : grace ? "grace" : active ? "active" : "expired",
    validUntil,
  };
}

export function createStoreVerifier(env: Env, http: HttpClient = fetch): StoreVerifier {
  const appleEnvironment = env.APPLE_ENVIRONMENT === "Sandbox" ? "Sandbox" : "Production";
  let apple: SignedDataVerifier | undefined;
  async function appleVerifier() {
    if (!apple) {
      // jsrsasign initializes randomness; Workers must load it inside a request, never at module scope.
      const { SignedDataVerifier, Environment } = await import("@apple/app-store-server-library");
      const roots = z
        .array(z.string().min(1))
        .min(1)
        .parse(JSON.parse(required(env.APPLE_ROOT_CERTIFICATES, "APPLE_NOT_CONFIGURED")));
      // Use only Apple-published, deployment-configured roots. Never trust x5c roots supplied by a caller.
      apple = new SignedDataVerifier(
        roots.map((cert) => Buffer.from(cert, "base64")),
        true,
        appleEnvironment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION,
        required(env.APPLE_BUNDLE_ID, "APPLE_NOT_CONFIGURED"),
        env.APPLE_APP_ID ? Number(env.APPLE_APP_ID) : undefined,
      );
    }
    return apple;
  }
  async function appleJwt() {
    const key = await importPKCS8(required(env.APPLE_PRIVATE_KEY, "APPLE_NOT_CONFIGURED"), "ES256");
    return new SignJWT({ bid: required(env.APPLE_BUNDLE_ID, "APPLE_NOT_CONFIGURED") })
      .setProtectedHeader({
        alg: "ES256",
        kid: required(env.APPLE_KEY_ID, "APPLE_NOT_CONFIGURED"),
        typ: "JWT",
      })
      .setIssuer(required(env.APPLE_ISSUER_ID, "APPLE_NOT_CONFIGURED"))
      .setAudience("appstoreconnect-v1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }
  async function verifyApple(reference: string): Promise<VerifiedSubscription> {
    const host =
      appleEnvironment === "Sandbox"
        ? "https://api.storekit-sandbox.itunes.apple.com"
        : "https://api.storekit.itunes.apple.com";
    const response = await http(
      `${host}/inApps/v1/subscriptions/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${await appleJwt()}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      },
    );
    if (!response.ok)
      throw new AppError(response.status === 404 ? 422 : 503, "APPLE_VERIFICATION_FAILED");
    const body = z
      .object({
        data: z.array(
          z.object({
            lastTransactions: z.array(
              z.object({
                status: z.number(),
                originalTransactionId: z.string(),
                signedTransactionInfo: z.string(),
                signedRenewalInfo: z.string().optional(),
              }),
            ),
          }),
        ),
      })
      .parse(await response.json());
    const results: VerifiedSubscription[] = [];
    const map = productMap(env).apple;
    for (const group of body.data)
      for (const entry of group.lastTransactions) {
        const transaction = await (
          await appleVerifier()
        ).verifyAndDecodeTransaction(entry.signedTransactionInfo);
        const renewal = entry.signedRenewalInfo
          ? await (await appleVerifier()).verifyAndDecodeRenewalInfo(entry.signedRenewalInfo)
          : null;
        if (
          transaction.originalTransactionId !== entry.originalTransactionId ||
          (renewal?.originalTransactionId &&
            renewal.originalTransactionId !== transaction.originalTransactionId)
        )
          throw new AppError(422, "TRANSACTION_MISMATCH");
        if (
          !transaction.productId ||
          !map[transaction.productId] ||
          transaction.type !== "Auto-Renewable Subscription"
        )
          continue;
        if (
          !transaction.appAccountToken ||
          !transaction.originalTransactionId ||
          !transaction.expiresDate
        )
          throw new AppError(422, "PURCHASE_ACCOUNT_BINDING_REQUIRED");
        if (transaction.storefront !== "JPN") throw new AppError(422, "JAPAN_PURCHASE_REQUIRED");
        const grace = entry.status === 4 && !!renewal?.gracePeriodExpiresDate;
        const validUntil = grace ? renewal!.gracePeriodExpiresDate! : transaction.expiresDate;
        const revoked = !!transaction.revocationDate || entry.status === 5;
        results.push({
          store: "apple",
          accountToken: transaction.appAccountToken,
          reference: transaction.originalTransactionId,
          productId: transaction.productId,
          plan: map[transaction.productId]!,
          status: revoked
            ? "revoked"
            : validUntil <= Date.now()
              ? "expired"
              : grace
                ? "grace"
                : entry.status === 1
                  ? "active"
                  : "expired",
          validUntil,
        });
      }
    // This app must use one subscription group. A mismatched appAccountToken is rejected downstream.
    const matching = results.filter((result) => result.reference === reference);
    const result = (matching.length ? matching : results).sort(
      (a, b) => b.validUntil - a.validUntil,
    )[0];
    if (!result) throw new AppError(422, "UNSUPPORTED_PRODUCT");
    return result;
  }
  async function googleAccessToken() {
    const key = await importPKCS8(
      required(env.GOOGLE_PRIVATE_KEY, "GOOGLE_NOT_CONFIGURED"),
      "RS256",
    );
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/androidpublisher",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(required(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, "GOOGLE_NOT_CONFIGURED"))
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    const response = await http("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok) throw new AppError(503, "GOOGLE_AUTH_FAILED");
    return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
  }
  async function verifyGoogle(
    reference: string,
    expectedAccountToken?: string,
  ): Promise<VerifiedSubscription> {
    const packageName = required(env.GOOGLE_PACKAGE_NAME, "GOOGLE_NOT_CONFIGURED");
    const accessToken = await googleAccessToken();
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases`;
    const response = await http(`${base}/subscriptionsv2/tokens/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok)
      throw new AppError(response.status === 404 ? 422 : 503, "GOOGLE_VERIFICATION_FAILED");
    const raw = googlePurchaseSchema.parse(await response.json());
    const result = normalizeGooglePurchase(raw, reference, env);
    if (expectedAccountToken && result.accountToken !== expectedAccountToken)
      throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
    // Acknowledge only verified, entitled subscriptions. Never trust a client-side flag.
    if (
      ["active", "grace"].includes(result.status) &&
      raw.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING"
    ) {
      const productId = result.productId.split(":")[0]!;
      const ack = await http(
        `${base}/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(reference)}:acknowledge`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        },
      );
      if (!ack.ok) throw new AppError(503, "GOOGLE_ACKNOWLEDGEMENT_FAILED");
    }
    return result;
  }
  return {
    async restore(proof) {
      if (proof.store === "google") return verifyGoogle(proof.purchaseToken);
      let transaction;
      try {
        transaction = await (
          await appleVerifier()
        ).verifyAndDecodeTransaction(proof.signedTransaction);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(401, "INVALID_APPLE_SIGNATURE");
      }
      // A family member's entitlement must never grant access to the purchaser's private data.
      if (transaction.inAppOwnershipType !== "PURCHASED")
        throw new AppError(403, "PURCHASE_OWNER_REQUIRED");
      if (
        !transaction.originalTransactionId ||
        !transaction.appAccountToken ||
        transaction.type !== "Auto-Renewable Subscription" ||
        !transaction.productId ||
        !productMap(env).apple[transaction.productId]
      )
        throw new AppError(422, "PURCHASE_ACCOUNT_BINDING_REQUIRED");
      if (transaction.storefront !== "JPN") throw new AppError(422, "JAPAN_PURCHASE_REQUIRED");
      // The signed proof can be historical. Only the server's current state grants access.
      const current = await verifyApple(transaction.originalTransactionId);
      if (
        current.reference !== transaction.originalTransactionId ||
        current.accountToken !== transaction.appAccountToken
      )
        throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
      return current;
    },
    verify: (store, reference, expectedAccountToken) =>
      store === "apple" ? verifyApple(reference) : verifyGoogle(reference, expectedAccountToken),
    async appleNotification(signedPayload) {
      try {
        const notification = await (
          await appleVerifier()
        ).verifyAndDecodeNotification(signedPayload);
        if (!notification.notificationUUID) throw new Error("Missing notification UUID");
        if (!notification.data?.signedTransactionInfo) return { id: notification.notificationUUID };
        const transaction = await (
          await appleVerifier()
        ).verifyAndDecodeTransaction(notification.data.signedTransactionInfo);
        return {
          id: notification.notificationUUID,
          reference: transaction.originalTransactionId,
          accountToken: transaction.appAccountToken,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(401, "INVALID_APPLE_SIGNATURE");
      }
    },
    async googlePushAuthorization(token) {
      const audience = required(env.GOOGLE_PUBSUB_AUDIENCE, "GOOGLE_NOT_CONFIGURED"),
        email = required(env.GOOGLE_PUBSUB_EMAIL, "GOOGLE_NOT_CONFIGURED");
      try {
        const { payload } = await jwtVerify(token, googleKeys, {
          audience,
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          algorithms: ["RS256"],
        });
        if (payload.email !== email || payload.email_verified !== true)
          throw new Error("Invalid Pub/Sub identity");
      } catch {
        throw new AppError(401, "INVALID_GOOGLE_SIGNATURE");
      }
    },
  };
}
