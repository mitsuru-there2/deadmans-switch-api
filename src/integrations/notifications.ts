import { and, eq, gt, like, lt } from "drizzle-orm";
import { z } from "zod";
import type { Env } from "../env";
import type { Database } from "../db/client";
import { outbox, webhookEvents } from "../db/schema";
import { renderNotice } from "../emails/notice";
import { AppError } from "../lib/errors";
import { gatewayTransport, recordResult, type Transport } from "../services/notifications";

export type HttpClient = typeof fetch;
export function notificationTransport(env: Env, http: HttpClient = fetch): Transport {
  if (env.NOTIFICATION_DRIVER !== "native") return gatewayTransport(env);
  return async (id, notice) => {
    if (notice.channel === "sms") return { state: "failed" };
    try {
      if (notice.channel === "email") {
        if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { state: "failed" };
        const content = await renderNotice(notice);
        const response = await http("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": id,
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [notice.to],
            ...content,
            tags: [{ name: "outbox_id", value: id }],
          }),
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });
        if (!response.ok) return { state: "uncertain" };
        const body = z.object({ id: z.string().min(1) }).parse(await response.json());
        return { state: "accepted", providerId: `resend:${body.id}` };
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
export async function verifyResendWebhook(
  env: Env,
  raw: string,
  headers: Headers,
  now = Date.now(),
) {
  if (!env.RESEND_WEBHOOK_SECRET?.startsWith("whsec_"))
    throw new AppError(503, "RESEND_NOT_CONFIGURED");
  const id = headers.get("svix-id") ?? "",
    timestamp = headers.get("svix-timestamp") ?? "";
  if (!id || !/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300_000)
    throw new AppError(401, "INVALID_SIGNATURE");
  const secret = atob(env.RESEND_WEBHOOK_SECRET.slice(6));
  // Svix signs with the decoded binary secret, not the UTF-8 representation of the Base64.
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret, (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  let valid = false;
  for (const entry of (headers.get("svix-signature") ?? "").split(" ")) {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature) continue;
    try {
      valid ||= await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
        signed,
      );
    } catch {
      /* Invalid candidate signature. */
    }
  }
  if (!valid) throw new AppError(401, "INVALID_SIGNATURE");
  return {
    id,
    event: z
      .object({
        type: z.string(),
        data: z.object({ email_id: z.string(), tags: z.record(z.string(), z.string()).optional() }),
      })
      .parse(JSON.parse(raw)),
  };
}
export async function processResendWebhook(
  db: Database,
  env: Env,
  raw: string,
  headers: Headers,
  now = Date.now(),
) {
  const { id, event } = await verifyResendWebhook(env, raw, headers, now);
  const state =
    event.type === "email.delivered"
      ? "delivered"
      : ["email.bounced", "email.failed", "email.complained", "email.suppressed"].includes(
            event.type,
          )
        ? "failed"
        : null;
  if (!state) return;
  await db.transaction(
    async (tx) => {
      // Match even if the HTTP request timed out after Resend accepted it.
      const row =
        (
          await tx
            .select()
            .from(outbox)
            .where(eq(outbox.providerId, `resend:${event.data.email_id}`))
        )[0] ??
        (event.data.tags?.outbox_id
          ? (await tx.select().from(outbox).where(eq(outbox.id, event.data.tags.outbox_id)))[0]
          : undefined);
      if (!row) throw new AppError(503, "DELIVERY_NOT_RECORDED_YET");
      const inserted = await tx
        .insert(webhookEvents)
        .values({ id: `resend:${id}`, createdAt: now })
        .onConflictDoNothing()
        .returning();
      if (inserted.length)
        await recordResult(tx, row.id, { state, providerId: `resend:${event.data.email_id}` }, now);
    },
    { behavior: "immediate" },
  );
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
    await db.transaction((tx) =>
      recordResult(tx, job.id, { state, providerId: job.providerId! }, now),
    );
  }
}
