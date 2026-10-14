// Unwired integration seam: authenticates provider evidence and produces direct-store
// verification hints only. It never grants entitlements, registers owners or restores sessions.
import { z } from "zod";
import { AppError } from "../lib/errors";
import { secretEqual, verifySignature } from "../lib/crypto";
import type { StoreVerifier } from "./stores";

const verifiedHint = Symbol("verified-revenuecat-hint");
export interface RevenueCatWebhookConfig {
  authorization: string;
  signingSecret: string;
  appId: string;
  environment: "SANDBOX" | "PRODUCTION";
}
export interface RevenueCatAppleHint {
  readonly [verifiedHint]: true;
  eventId: string;
  appUserId: string;
  transactionId: string;
}
export type RevenueCatHintResult =
  | { kind: "apple_transaction_hint"; hint: RevenueCatAppleHint }
  | { kind: "requires_store_proof"; eventId: string }
  | { kind: "ignored"; eventId: string; reason: "unsupported_event" | "ownership_review_required" };
const eventSchema = z.object({
  api_version: z.literal("1.0"),
  event: z.object({
    id: z.string().min(1).max(200),
    type: z.string(),
    app_id: z.string(),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    app_user_id: z.string().min(1).max(256).optional(),
    transaction_id: z.string().max(200).optional(),
    store: z.string().optional(),
    is_family_share: z.boolean().optional(),
  }),
});
const lifecycle = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "CANCELLATION",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "EXPIRATION",
  "BILLING_ISSUE",
  "PRODUCT_CHANGE",
]);

export async function verifyRevenueCatWebhook(
  rawBody: string,
  headers: Headers,
  config: RevenueCatWebhookConfig,
  now = Date.now(),
): Promise<RevenueCatHintResult> {
  if (!config.authorization || !config.signingSecret || !config.appId)
    throw new AppError(503, "REVENUECAT_NOT_CONFIGURED");
  if (new TextEncoder().encode(rawBody).length > 128 * 1024)
    throw new AppError(400, "INVALID_REQUEST");
  if (!(await secretEqual(headers.get("Authorization") ?? "", config.authorization)))
    throw new AppError(401, "INVALID_REVENUECAT_SIGNATURE");
  const signature = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/i.exec(
    headers.get("X-RevenueCat-Webhook-Signature") ?? "",
  );
  if (!signature || Math.abs(now - Number(signature[1]) * 1000) > 300_000)
    throw new AppError(401, "INVALID_REVENUECAT_SIGNATURE");
  const bytes = Uint8Array.from(signature[2]!.match(/../g)!, (value) => Number.parseInt(value, 16));
  if (
    !(await verifySignature(
      config.signingSecret,
      `${signature[1]}.${rawBody}`,
      btoa(String.fromCharCode(...bytes)),
    ))
  )
    throw new AppError(401, "INVALID_REVENUECAT_SIGNATURE");
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new AppError(400, "INVALID_REQUEST");
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, "INVALID_REQUEST");
  const event = parsed.data.event;
  if (event.app_id !== config.appId || event.environment !== config.environment)
    throw new AppError(403, "REVENUECAT_APP_MISMATCH");
  if (event.type === "TRANSFER" || event.is_family_share)
    return { kind: "ignored", eventId: event.id, reason: "ownership_review_required" };
  if (!lifecycle.has(event.type))
    return { kind: "ignored", eventId: event.id, reason: "unsupported_event" };
  if (event.store !== "APP_STORE") return { kind: "requires_store_proof", eventId: event.id };
  if (!event.app_user_id || !/^\d{1,100}$/.test(event.transaction_id ?? ""))
    throw new AppError(400, "INVALID_REQUEST");
  return {
    kind: "apple_transaction_hint",
    hint: {
      [verifiedHint]: true,
      eventId: event.id,
      appUserId: event.app_user_id,
      transactionId: event.transaction_id!,
    },
  };
}

// An authenticated owner's existing profile ID must come from the API session.
// Aliases, original_app_user_id and SDK attributes are never owner credentials.
export async function verifyRevenueCatAppleHint(
  hint: RevenueCatAppleHint,
  authenticatedProfileId: string,
  verifier: StoreVerifier,
) {
  if (hint[verifiedHint] !== true || hint.appUserId !== authenticatedProfileId)
    throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
  const current = await verifier.verify("apple", hint.transactionId, authenticatedProfileId);
  if (current.store !== "apple" || current.accountToken !== authenticatedProfileId)
    throw new AppError(403, "PURCHASE_ACCOUNT_MISMATCH");
  return current;
}
