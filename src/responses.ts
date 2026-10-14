import { z } from "zod";
import { receivedResponseSchema } from "./contracts";

const time = z.number().int();
const nullableTime = time.nullable();
const id = z.string();
export const switchStateSchema = z.enum(["draft", "active", "grace", "paused", "held", "released"]);
export const entitlementStatusSchema = z.enum(["active", "grace", "expired", "revoked"]);
export const planSchema = z.enum(["basic", "plus"]);
export const activationBlockerSchema = z.enum([
  "PAUSE_BEFORE_EDITING",
  "VERIFIED_EMAIL_REQUIRED",
  "ACTIVE_ENTITLEMENT_REQUIRED",
  "MONITORING_UNHEALTHY",
  "DELIVERY_DISABLED",
  "SELF_TEST_REQUIRED",
  "SMS_NOT_SUPPORTED",
  "RECIPIENTS_NOT_READY",
]);
export type ActivationBlocker = z.infer<typeof activationBlockerSchema>;
export const profileSchema = z
  .object({
    id,
    userId: id,
    state: switchStateSchema,
    version: z.number().int(),
    inactivityDays: z.number().int(),
    graceDays: z.number().int(),
    lastCheckInAt: nullableTime,
    graceStartedAt: nullableTime,
    warningAcceptedAt: nullableTime,
    lastReminderAt: nullableTime,
    holdReason: z.string().nullable(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export const entitlementSchema = z
  .object({
    profileId: id,
    plan: planSchema,
    status: entitlementStatusSchema,
    validUntil: time,
    sourceVersion: time,
  })
  .strict();
export const switchStatusSchema = profileSchema.extend({
  entitlement: entitlementSchema.nullable(),
  confirmationDueAt: nullableTime,
  earliestReleaseAt: nullableTime,
  consentVersion: z.string(),
  serverTime: time,
  activationBlockers: z.array(activationBlockerSchema),
});
export const meResponseSchema = z
  .object({
    user: z.object({ id, email: z.string().nullable(), emailVerified: z.boolean() }).strict(),
    switch: switchStatusSchema,
  })
  .strict();
export const recipientSchema = z
  .object({
    id,
    channel: z.enum(["email", "sms"]),
    status: z.enum(["pending", "accepted", "declined", "reported"]),
    acceptedAt: nullableTime,
    invitationExpiresAt: nullableTime,
    nextInvitationAt: nullableTime,
    name: z.string(),
    email: z.string(),
    phone: z.string().optional(),
  })
  .strict();
export const recipientsResponseSchema = z.object({ recipients: z.array(recipientSchema) }).strict();
export const messageResponseSchema = z
  .object({
    id,
    recipientId: id,
    revision: z.number().int(),
    updatedAt: time,
    title: z.string(),
    body: z.string(),
  })
  .strict();
export const messagesResponseSchema = z
  .object({ messages: z.array(messageResponseSchema) })
  .strict();
export const deliveryStateSchema = z.enum([
  "pending",
  "sending",
  "accepted",
  "delivered",
  "failed",
  "uncertain",
  "cancelled",
]);
export const deliverySchema = z
  .object({
    id,
    recipientId: id.nullable(),
    kind: z.enum(["auth", "invitation", "reminder", "warning", "final", "self_test"]),
    state: deliveryStateSchema,
    createdAt: time,
  })
  .strict();
export const deliveriesResponseSchema = z.object({ deliveries: z.array(deliverySchema) }).strict();
export const selfTestResponseSchema = z
  .object({ queued: z.literal(true), deliveryId: id })
  .strict();
export const billingAccountSchema = z
  .object({
    accountToken: id,
    products: z
      .object({ apple: z.record(z.string(), planSchema), google: z.record(z.string(), planSchema) })
      .strict(),
  })
  .strict();
export const subscriptionsResponseSchema = z
  .object({
    subscriptions: z.array(
      z
        .object({
          store: z.enum(["apple", "google"]),
          productId: z.string(),
          plan: planSchema,
          status: entitlementStatusSchema,
          validUntil: time,
          verifiedAt: time,
        })
        .strict(),
    ),
  })
  .strict();
export const deviceSessionSchema = z.object({ token: z.string(), expiresAt: time }).strict();
export const bootstrapResponseSchema = deviceSessionSchema.extend({ accountToken: id, userId: id });
export const currentConsentSchema = z
  .object({
    version: z.string(),
    language: z.literal("ja"),
    effectiveAt: time,
    title: z.string(),
    body: z.string(),
  })
  .strict();
export const auditResponseSchema = z
  .object({
    events: z.array(
      z
        .object({
          id,
          profileId: id,
          action: z.string(),
          version: z.number().int(),
          createdAt: time,
        })
        .strict(),
    ),
  })
  .strict();
export const exportResponseSchema = z
  .object({
    exportedAt: time,
    switch: switchStatusSchema,
    recipients: z.array(recipientSchema),
    messages: z.array(messageResponseSchema),
  })
  .strict();
const queued = z.object({ queued: z.literal(true) }).strict();
const version = z.object({ version: z.number().int() }).strict();
export const successResponses: Record<string, z.ZodType> = {
  "post /v1/auth/bootstrap": bootstrapResponseSchema,
  "post /v1/auth/restore": bootstrapResponseSchema,
  "post /v1/auth/device-session": deviceSessionSchema,
  "post /v1/contact-email": queued,
  "post /v1/contact-email/confirm": z.object({ verified: z.literal(true) }).strict(),
  "get /v1/me": meResponseSchema,
  "get /v1/switch": switchStatusSchema,
  "get /v1/consents/current": currentConsentSchema,
  "patch /v1/switch": profileSchema,
  "post /v1/switch/activate": profileSchema,
  "post /v1/switch/pause": profileSchema,
  "post /v1/check-ins": profileSchema,
  "get /v1/recipients": recipientsResponseSchema,
  "post /v1/recipients": z
    .object({ id, version: z.number().int(), status: z.literal("pending") })
    .strict(),
  "delete /v1/recipients/{id}": version,
  "post /v1/recipients/{id}/invite": queued,
  "get /v1/messages": messagesResponseSchema,
  "put /v1/recipients/{id}/message": z
    .object({ id, revision: z.number().int(), version: z.number().int() })
    .strict(),
  "delete /v1/recipients/{id}/message": version,
  "post /v1/invitations/preview": z
    .object({
      recipientId: id,
      channel: z.enum(["email", "sms"]),
      status: z.enum(["pending", "accepted", "declined", "reported"]),
      name: z.string(),
      senderName: z.string(),
      expiresAt: time,
    })
    .strict(),
  "post /v1/invitations/respond": z
    .object({ status: z.enum(["accept", "decline", "report"]) })
    .strict(),
  "post /v1/recipient-consents/{id}/withdraw": z
    .object({ status: z.enum(["decline", "report"]) })
    .strict(),
  "post /v1/received": receivedResponseSchema,
  "get /v1/billing/account": billingAccountSchema,
  "get /v1/billing/subscriptions": subscriptionsResponseSchema,
  "post /v1/billing/verify": entitlementSchema,
  "post /v1/devices": z.object({ id }).strict(),
  "post /v1/self-test": selfTestResponseSchema,
  "get /v1/deliveries": deliveriesResponseSchema,
  "get /v1/audit": auditResponseSchema,
  "get /v1/export": exportResponseSchema,
};
export type SwitchStatus = z.infer<typeof switchStatusSchema>;
export type ProfileResponse = z.infer<typeof profileSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type Recipient = z.infer<typeof recipientSchema>;
export type Message = z.infer<typeof messageResponseSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type BillingAccount = z.infer<typeof billingAccountSchema>;
export type SubscriptionsResponse = z.infer<typeof subscriptionsResponseSchema>;
export type DeviceSession = z.infer<typeof deviceSessionSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type CurrentConsent = z.infer<typeof currentConsentSchema>;
