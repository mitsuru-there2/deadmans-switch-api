import { z } from "zod";
export const versionSchema = z.object({ version: z.number().int().positive() }).strict();
export const tokenSchema = z.string().min(32).max(256);
export const bootstrapSchema = z.object({}).strict();
export const contactEmailSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .refine((email) => !email.toLowerCase().endsWith(".invalid")),
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export const confirmContactSchema = z.object({ token: tokenSchema }).strict();
export const contactSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    channel: z.literal("email"),
    email: z.email().max(254),
  })
  .strict();
export const settingsSchema = z
  .object({
    version: z.number().int().positive(),
    inactivityDays: z.number().int().min(7).max(365),
    graceDays: z.number().int().min(3).max(30),
  })
  .strict();
export const activationSchema = versionSchema.extend({
  consentVersion: z.string(),
  confirmed: z.literal(true),
});
export const checkInSchema = z
  .object({ kind: z.enum(["foreground", "notification_action"]) })
  .strict();
export const messageSchema = versionSchema.extend({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
});
export const invitationSchema = z
  .object({
    token: tokenSchema,
    action: z.enum(["accept", "decline", "report"]),
  })
  .strict();
export const previewSchema = z.object({ token: tokenSchema }).strict();
export const withdrawalSchema = z.object({ action: z.enum(["decline", "report"]) }).strict();
export const receivedSchema = z.discriminatedUnion("action", [
  z.object({ token: tokenSchema, action: z.literal("preview") }).strict(),
  z
    .object({
      token: tokenSchema,
      action: z.literal("read"),
      deathConfirmed: z.literal(true),
      noticeVersion: z.string().min(1).max(100),
    })
    .strict(),
  z.object({ token: tokenSchema, action: z.enum(["decline", "report"]) }).strict(),
]);
export const deviceSchema = z
  .object({
    token: z
      .string()
      .regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/)
      .max(300),
  })
  .strict();
export const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE") }).strict();
export const webhookSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string().min(1).max(200),
      type: z.literal("entitlement"),
      userId: z.string(),
      plan: z.enum(["basic", "plus"]),
      status: z.enum(["active", "grace", "expired", "revoked"]),
      validUntil: z.number().int().positive(),
      sourceVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(200),
      type: z.literal("delivery"),
      outboxId: z.string(),
      state: z.enum(["accepted", "delivered", "failed"]),
      providerId: z.string().min(1),
    })
    .strict(),
]);

export const purchaseSchema = z.discriminatedUnion("store", [
  z
    .object({ store: z.literal("apple"), transactionId: z.string().regex(/^\d+$/).max(100) })
    .strict(),
  z.object({ store: z.literal("google"), purchaseToken: z.string().min(10).max(4096) }).strict(),
]);

// Unlike billing verification, restoring private data requires possession of the full proof.
const operationSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const restoreResultSchema = z.object({ operationSecret }).strict();
export const restorePurchaseSchema = z.discriminatedUnion("store", [
  z
    .object({
      store: z.literal("apple"),
      signedTransaction: z.string().min(100).max(100_000),
      operationSecret: operationSecret.optional(),
    })
    .strict(),
  z
    .object({
      store: z.literal("google"),
      purchaseToken: z.string().min(10).max(4096),
      operationSecret: operationSecret.optional(),
    })
    .strict(),
]);

export const receivedResponseSchema = z.union([
  z
    .object({
      senderName: z.string(),
      notice: z.string(),
      noticeVersion: z.string(),
      expiresAt: z.number(),
    })
    .strict(),
  z
    .object({
      message: z.object({ title: z.string(), body: z.string() }).strict(),
      expiresAt: z.number(),
    })
    .strict(),
  z.object({ status: z.enum(["decline", "report"]) }).strict(),
]);
export type ReceivedRequest = z.infer<typeof receivedSchema>;
export type ReceivedResponse = z.infer<typeof receivedResponseSchema>;
