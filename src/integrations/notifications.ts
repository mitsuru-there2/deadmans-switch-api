import { sendEmail, type SendEmailOptions, type SendEmailResult } from "void/email";
import { atomic } from "../db/client";
import { and, eq, gt, like, lt } from "drizzle-orm";
import { z } from "zod";
import type { Env } from "../config";
import type { Database } from "../db/client";
import { outbox, webhookEvents } from "../db/schema";
import { renderNotice } from "../emails/notice";
import { AppError } from "../lib/errors";
import { gatewayTransport, recordResult, type Transport } from "../services/notifications";

export type HttpClient = typeof fetch;
export function notificationTransport(
  env: Env,
  http: HttpClient = fetch,
  mail: (options: SendEmailOptions) => Promise<SendEmailResult> = sendEmail,
): Transport {
  if (env.NOTIFICATION_DRIVER !== "native") return gatewayTransport(env);
  return async (id, notice) => {
    if (notice.channel === "sms") return { state: "failed" };
    try {
      if (notice.channel === "email") {
        if (!env.EMAIL_FROM) return { state: "failed" };
        const content = await renderNotice(notice);
        const result = await mail({
          from: env.EMAIL_FROM,
          to: notice.to,
          ...content,
          idempotencyKey: id,
          headers: { "X-Outbox-ID": id },
        });
        if (result.ok) {
          const messageId = result.ids[0]?.messageId;
          return messageId
            ? { state: "accepted", providerId: `void:${messageId}` }
            : { state: "uncertain" };
        }
        const unknown =
          "error" in result
            ? result.error.code === "OUTCOME_UNKNOWN"
            : result.deliveries.some(
                (delivery) => !delivery.ok && delivery.error.code === "OUTCOME_UNKNOWN",
              );
        return { state: unknown ? "uncertain" : "failed" };
      }
      const response = await http("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          to: notice.to,
          title: "確認のお願い",
          body: "アプリを開いて確認してください。",
          data: { action: "check-in" },
          sound: "default",
          ttl: 86_400,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      if (!response.ok) return { state: "uncertain" };
      const { data } = z
        .object({
          data: z.object({
            status: z.enum(["ok", "error"]),
            id: z.string().optional(),
            details: z.object({ error: z.string().optional() }).optional(),
          }),
        })
        .parse(await response.json());
      if (data.status === "ok" && data.id)
        return { state: "accepted", providerId: `expo:${data.id}` };
      // Delete tokens only for a definitive invalid-device result, not configuration errors.
      return { state: data.details?.error === "DeviceNotRegistered" ? "failed" : "uncertain" };
    } catch {
      return { state: "uncertain" };
    }
  };
}
// Only invoked by the Cloudflare Queue consumer, never an unauthenticated HTTP route.
const emailEventSchema = z.object({
  type: z.string(),
  payload: z.object({ eventId: z.string().min(1), messageId: z.string().min(1) }),
});
export async function processEmailEvent(db: Database, body: unknown, now = Date.now()) {
  const event = emailEventSchema.parse(body);
  const state =
    event.type === "cf.email.sending.message.delivered"
      ? "delivered"
      : ["bounced", "failed", "rejected", "complained"].some(
            (suffix) => event.type === `cf.email.sending.message.${suffix}`,
          )
        ? "failed"
        : null;
  if (!state) return;
  await atomic(db, async (tx) => {
    const eventId = `cloudflare-email:${event.payload.eventId}`;
    if ((await tx.select().from(webhookEvents).where(eq(webhookEvents.id, eventId))).length) return;
    const row = (
      await tx
        .select()
        .from(outbox)
        .where(eq(outbox.providerId, `void:${event.payload.messageId}`))
    )[0];
    if (!row) throw new AppError(503, "DELIVERY_NOT_RECORDED_YET");
    await tx.insert(webhookEvents).values({ id: eventId, createdAt: now });
    await recordResult(tx, row.id, { state, providerId: row.providerId! }, now);
  });
}
export async function pollExpoReceipts(
  db: Database,
  env: Env,
  http: HttpClient = fetch,
  now = Date.now(),
) {
  if (env.NOTIFICATION_DRIVER !== "native") return;
  const jobs = await db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.state, "accepted"),
        like(outbox.providerId, "expo:%"),
        lt(outbox.claimedAt, now - 15 * 60_000),
        gt(outbox.claimedAt, now - 24 * 60 * 60_000),
      ),
    )
    .limit(100);
  if (!jobs.length) return;
  const response = await http("https://exp.host/--/api/v2/push/getReceipts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify({ ids: jobs.map((job) => job.providerId!.slice(5)) }),
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (!response.ok) return;
  const { data } = z
    .object({
      data: z.record(
        z.string(),
        z.object({
          status: z.enum(["ok", "error"]),
          details: z.object({ error: z.string().optional() }).optional(),
        }),
      ),
    })
    .parse(await response.json());
  for (const job of jobs) {
    const receipt = data[job.providerId!.slice(5)];
    if (!receipt) continue;
    const state =
      receipt.status === "ok"
        ? "delivered"
        : receipt.details?.error === "DeviceNotRegistered"
          ? "failed"
          : "uncertain";
    await atomic(db, (tx) => recordResult(tx, job.id, { state, providerId: job.providerId! }, now));
  }
}
