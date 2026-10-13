import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createAuth, type Auth } from "./auth";
import { connectDb, type Database } from "./db/client";
import {
  audit,
  devices,
  entitlements,
  outbox,
  profiles,
  systemHealth,
  user,
  webhookEvents,
  storeSubscriptions,
} from "./db/schema";
import { parseEnv, type Env } from "./env";
import { secretEqual, verifySignature } from "./lib/crypto";
import { DeviceAuthService } from "./services/device-auth";
import { AppError, requireValue } from "./lib/errors";
import { rateLimit } from "./lib/rate-limit";
import { dispatch, enqueue, recordResult, type Transport } from "./services/notifications";
import {
  notificationTransport,
  pollExpoReceipts,
  processResendWebhook,
} from "./integrations/notifications";
import { createStoreVerifier, productMap, type StoreVerifier } from "./integrations/stores";
import { BillingService } from "./services/billing";
import { probe, tick } from "./services/scheduler";
import { DAY, invalidate, isEntitled, log, SwitchService } from "./services/switch";

import {
  versionSchema,
  contactSchema,
  settingsSchema,
  activationSchema,
  checkInSchema,
  messageSchema,
  invitationSchema,
  previewSchema,
  withdrawalSchema,
  receivedSchema,
  deviceSchema,
  deleteAccountSchema,
  webhookSchema,
  purchaseSchema,
  bootstrapSchema,
  contactEmailSchema,
  confirmContactSchema,
  restorePurchaseSchema,
} from "./contracts";
import { openApiDocument } from "./openapi";

type SessionUser = Auth["$Infer"]["Session"]["user"];
type Variables = {
  db: Database;
  service: SwitchService;
  auth: Auth;
  config: Env;
  user: SessionUser;
  deviceToken: string | undefined;
};
export interface AppDependencies {
  db?: Database;
  transport?: Transport;
  now?: () => number;
  storeVerifier?: StoreVerifier;
}
export function createApp(deps: AppDependencies = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const now = deps.now ?? Date.now;
  app.use("*", secureHeaders());
  app.use(
    "*",
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE" } }, 413),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    let env: Env;
    try {
      env = parseEnv(c.env);
    } catch {
      throw new AppError(503, "CONFIGURATION_INVALID");
    }
    c.set("config", env);
    const path = c.req.path;
    if (
      env.APP_ENV === "production" &&
      !path.startsWith("/internal/") &&
      !path.startsWith("/webhooks/") &&
      path !== "/health/live"
    ) {
      const country = (c.req.raw as Request & { cf?: { country?: string } }).cf?.country;
      if (country !== "JP") throw new AppError(403, "JAPAN_ONLY");
    }
    const origins = env.TRUSTED_ORIGINS.split(",").map((s) => s.trim());
    const origin = c.req.header("Origin");
    if (origin && !origins.includes(origin) && origin !== new URL(env.BETTER_AUTH_URL).origin)
      throw new AppError(403, "UNTRUSTED_ORIGIN");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("Sec-Fetch-Site") === "cross-site"
    )
      throw new AppError(403, "CROSS_SITE_REQUEST");
    await cors({
      origin: origins,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["set-auth-token"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    })(c, async () => {
      const connection = deps.db ? null : connectDb(env);
      const db = deps.db ?? connection!.db;
      c.set("db", db);
      c.set("service", new SwitchService(db, env, now));
      c.set("auth", createAuth(db, env));
      try {
        await next();
      } finally {
        connection?.client.close();
      }
    });
  });
  app.get("/openapi.json", (c) => c.json(openApiDocument));
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    await c.get("db").select({ id: systemHealth.id }).from(systemHealth).limit(1);
    return c.json({ status: "ok" });
  });
  // Provision an identity silently. It has no application access until a store verifies a purchase.
  app.post("/v1/auth/bootstrap", async (c) => {
    bootstrapSchema.parse(await c.req.json());
    await rateLimit(
      c.get("db"),
      c.req.header("cf-connecting-ip") ?? "local",
      "bootstrap",
      10,
      60 * 60_000,
      now(),
    );
    return c.json(await new DeviceAuthService(c.get("db"), c.get("config"), now).bootstrap(), 201);
  });
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    // Reject unsafe redirect targets before enqueueing email, not only on link redemption.
    if (c.req.method === "POST" && c.req.path === "/api/auth/sign-in/magic-link") {
      const body = z
        .object({
          callbackURL: z.string().optional(),
          newUserCallbackURL: z.string().optional(),
          errorCallbackURL: z.string().optional(),
        })
        .parse(await c.req.raw.clone().json());
      const env = c.get("config");
      const allowed = [
        new URL(env.BETTER_AUTH_URL).origin,
        ...env.TRUSTED_ORIGINS.split(",").map((value) => value.trim()),
      ];
      for (const target of [body.callbackURL, body.newUserCallbackURL, body.errorCallbackURL]) {
        if (target === undefined) continue;
        try {
          const url = new URL(target, env.BETTER_AUTH_URL);
          if (!allowed.includes(url.origin) || url.username || url.password)
            throw new Error("untrusted");
        } catch {
          throw new AppError(403, "UNTRUSTED_REDIRECT");
        }
      }
    }
    return c.get("auth").handler(c.req.raw);
  });
  app.use("/v1/*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    const isDevice = token.startsWith("dms_");
    const u = isDevice
      ? await new DeviceAuthService(c.get("db"), c.get("config"), now).authenticate(token)
      : (await c.get("auth").api.getSession({ headers: c.req.raw.headers }))?.user;
    if (!u || (!isDevice && !u.emailVerified)) throw new AppError(401, "AUTHENTICATION_REQUIRED");
    c.set("user", u);
    c.set("deviceToken", isDevice ? token : undefined);
    await rateLimit(c.get("db"), u.id, "owner", 120, 60_000, now());
    const path = c.req.path,
      method = c.req.method;
    const recipientRoute =
      path.startsWith("/v1/invitations/") ||
      path.startsWith("/v1/recipient-consents/") ||
      path === "/v1/received";
    if (recipientRoute && !u.emailVerified) throw new AppError(403, "VERIFIED_EMAIL_REQUIRED");
    // Purchase/restore, account recovery, and data-control actions remain reachable after expiry.
    const exempt =
      recipientRoute ||
      path.startsWith("/v1/billing/") ||
      path.startsWith("/v1/auth/") ||
      path === "/v1/me" ||
      (path === "/v1/export" && method === "GET") ||
      (path === "/v1/switch/pause" && method === "POST") ||
      (path === "/v1/contact-email/confirm" && method === "POST");
    if (!exempt) {
      const p = await c.get("service").profile(u.id);
      const e = (
        await c.get("db").select().from(entitlements).where(eq(entitlements.profileId, p.id))
      )[0];
      if (!isEntitled(e, now())) throw new AppError(403, "SUBSCRIPTION_REQUIRED");
    }
    await next();
  });
  app.post("/v1/auth/device-session", async (c) =>
    c.json(
      await new DeviceAuthService(c.get("db"), c.get("config"), now).renew(
        c.get("user").id,
        c.get("deviceToken"),
      ),
    ),
  );
  app.delete("/v1/auth/device-sessions", async (c) => {
    await new DeviceAuthService(c.get("db"), c.get("config"), now).revoke(c.get("user").id);
    return c.body(null, 204);
  });
  app.post("/v1/contact-email", async (c) => {
    const data = contactEmailSchema.parse(await c.req.json());
    await rateLimit(c.get("db"), c.get("user").id, "contact-email", 3, DAY, now());
    await new DeviceAuthService(c.get("db"), c.get("config"), now).requestContact(
      c.get("user").id,
      data.email,
      data.name,
    );
    return c.json({ queued: true }, 202);
  });
  app.post("/v1/contact-email/confirm", async (c) => {
    const { token } = confirmContactSchema.parse(await c.req.json());
    await new DeviceAuthService(c.get("db"), c.get("config"), now).confirmContact(
      c.get("user").id,
      token,
    );
    return c.json({ verified: true });
  });
  const billing = (db: Database, env: Env) =>
    new BillingService(db, env, deps.storeVerifier ?? createStoreVerifier(env), now);
  app.post("/v1/auth/restore", async (c) => {
    const deviceToken = c.get("deviceToken");
    if (!deviceToken) throw new AppError(401, "DEVICE_AUTHENTICATION_REQUIRED");
    const proof = restorePurchaseSchema.parse(await c.req.json());
    await rateLimit(
      c.get("db"),
      c.req.header("cf-connecting-ip") ?? "local",
      "store-restore-ip",
      10,
      60_000,
      now(),
    );
    await rateLimit(c.get("db"), c.get("user").id, "store-restore", 5, 60_000, now());
    const verified = await billing(c.get("db"), c.get("config")).verifyRestoration(proof);
    return c.json(
      await new DeviceAuthService(c.get("db"), c.get("config"), now).restore(
        c.get("user").id,
        deviceToken,
        verified,
      ),
    );
  });
  app.get("/v1/billing/account", async (c) => {
    const p = await c.get("service").profile(c.get("user").id);
    return c.json({ accountToken: p.id, products: productMap(c.get("config")) });
  });
  app.get("/v1/billing/subscriptions", async (c) => {
    const p = await c.get("service").profile(c.get("user").id);
    return c.json({
      subscriptions: await c
        .get("db")
        .select({
          store: storeSubscriptions.store,
          productId: storeSubscriptions.productId,
          plan: storeSubscriptions.plan,
          status: storeSubscriptions.status,
          validUntil: storeSubscriptions.validUntil,
          verifiedAt: storeSubscriptions.verifiedAt,
        })
        .from(storeSubscriptions)
        .where(eq(storeSubscriptions.profileId, p.id)),
    });
  });
  app.post("/v1/billing/verify", async (c) => {
    await rateLimit(c.get("db"), c.get("user").id, "purchase-verification", 10, 60_000, now());
    const data = purchaseSchema.parse(await c.req.json());
    const p = await c.get("service").profile(c.get("user").id);
    return c.json(
      await billing(c.get("db"), c.get("config")).verifyPurchase(
        data.store,
        data.store === "apple" ? data.transactionId : data.purchaseToken,
        p.id,
      ),
    );
  });
  app.post("/webhooks/resend", async (c) => {
    await processResendWebhook(
      c.get("db"),
      c.get("config"),
      await c.req.text(),
      c.req.raw.headers,
      now(),
    );
    return c.json({ received: true });
  });
  app.post("/webhooks/apple", async (c) => {
    const { signedPayload } = z
      .object({ signedPayload: z.string().min(1).max(100_000) })
      .strict()
      .parse(await c.req.json());
    await billing(c.get("db"), c.get("config")).appleWebhook(signedPayload);
    return c.json({ received: true });
  });
  app.post("/webhooks/google", async (c) => {
    await billing(c.get("db"), c.get("config")).googleWebhook(
      c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
      await c.req.json(),
    );
    return c.json({ received: true });
  });
  app.get("/v1/me", async (c) =>
    c.json({
      user: {
        id: c.get("user").id,
        email: c.get("user").emailVerified ? c.get("user").email : null,
        emailVerified: c.get("user").emailVerified,
      },
      switch: await c.get("service").status(c.get("user").id),
    }),
  );
  app.get("/v1/switch", async (c) => c.json(await c.get("service").status(c.get("user").id)));
  app.patch("/v1/switch", async (c) =>
    c.json(
      await c
        .get("service")
        .changeSettings(c.get("user").id, settingsSchema.parse(await c.req.json())),
    ),
  );
  app.post("/v1/switch/activate", async (c) => {
    const data = activationSchema.parse(await c.req.json());
    return c.json(
      await c.get("service").activate(c.get("user").id, data.version, data.consentVersion),
    );
  });
  app.post("/v1/switch/pause", async (c) => c.json(await c.get("service").pause(c.get("user").id)));
  app.post("/v1/check-ins", async (c) => {
    const { kind } = checkInSchema.parse(await c.req.json());
    return c.json(await c.get("service").checkIn(c.get("user").id, kind));
  });
  app.get("/v1/recipients", async (c) =>
    c.json({ recipients: await c.get("service").listRecipients(c.get("user").id) }),
  );
  app.post("/v1/recipients", async (c) =>
    c.json(
      await c
        .get("service")
        .addRecipient(c.get("user").id, contactSchema.parse(await c.req.json())),
      201,
    ),
  );
  app.delete("/v1/recipients/:id", async (c) =>
    c.json(
      await c
        .get("service")
        .deleteRecipient(
          c.get("user").id,
          c.req.param("id"),
          versionSchema.parse(await c.req.json()).version,
        ),
    ),
  );
  app.post("/v1/recipients/:id/invite", async (c) => {
    await rateLimit(c.get("db"), c.get("user").id, "invitations", 10, DAY, now());
    await c.get("service").invite(c.get("user").id, c.req.param("id"));
    return c.json({ queued: true }, 202);
  });
  app.get("/v1/messages", async (c) =>
    c.json({ messages: await c.get("service").listMessages(c.get("user").id) }),
  );
  app.put("/v1/recipients/:id/message", async (c) =>
    c.json(
      await c
        .get("service")
        .writeMessage(c.get("user").id, c.req.param("id"), messageSchema.parse(await c.req.json())),
    ),
  );
  app.delete("/v1/recipients/:id/message", async (c) =>
    c.json(
      await c
        .get("service")
        .deleteMessage(
          c.get("user").id,
          c.req.param("id"),
          versionSchema.parse(await c.req.json()).version,
        ),
    ),
  );
  app.post("/v1/invitations/respond", async (c) => {
    const data = invitationSchema.parse(await c.req.json());
    return c.json(
      await c.get("service").respondInvitation(c.get("user").email, data.token, data.action),
    );
  });
  app.post("/v1/invitations/preview", async (c) => {
    const { token } = previewSchema.parse(await c.req.json());
    return c.json(await c.get("service").previewInvitation(c.get("user").email, token));
  });
  app.post("/v1/recipient-consents/:id/withdraw", async (c) => {
    const { action } = withdrawalSchema.parse(await c.req.json());
    return c.json(
      await c.get("service").withdrawConsent(c.get("user").email, c.req.param("id"), action),
    );
  });
  app.post("/v1/received", async (c) => {
    const data = receivedSchema.parse(await c.req.json());
    return c.json(
      await c.get("service").readDelivery(c.get("user").email, data.token, data.action),
    );
  });
  app.post("/v1/devices", async (c) => {
    const { token } = deviceSchema.parse(await c.req.json());
    return c.json(await c.get("service").addDevice(c.get("user").id, token), 201);
  });
  app.delete("/v1/devices/:id", async (c) => {
    const p = await c.get("service").profile(c.get("user").id);
    requireValue(
      (
        await c
          .get("db")
          .delete(devices)
          .where(and(eq(devices.id, c.req.param("id")), eq(devices.profileId, p.id)))
          .returning()
      )[0],
    );
    return c.body(null, 204);
  });
  app.post("/v1/self-test", async (c) => {
    if (!c.get("user").emailVerified) throw new AppError(403, "VERIFIED_EMAIL_REQUIRED");
    await rateLimit(c.get("db"), c.get("user").id, "self-test", 3, DAY, now());
    const p = await c.get("service").profile(c.get("user").id);
    await enqueue(
      c.get("db"),
      c.get("service").vault,
      "self_test",
      `test:${crypto.randomUUID()}`,
      {
        channel: "email",
        to: c.get("user").email,
        template: "self_test",
        url: `${c.get("config").RECIPIENT_WEB_URL}/self-test`,
        expiresAt: now() + DAY,
      },
      now(),
      { profileId: p.id },
    );
    return c.json({ queued: true }, 202);
  });
  app.get("/v1/deliveries", async (c) => {
    const p = await c.get("service").profile(c.get("user").id);
    return c.json({
      deliveries: await c
        .get("db")
        .select({
          id: outbox.id,
          recipientId: outbox.recipientId,
          kind: outbox.kind,
          state: outbox.state,
          createdAt: outbox.createdAt,
        })
        .from(outbox)
        .where(eq(outbox.profileId, p.id))
        .orderBy(desc(outbox.createdAt))
        .limit(200),
    });
  });
  app.get("/v1/audit", async (c) => {
    const p = await c.get("service").profile(c.get("user").id);
    return c.json({
      events: await c
        .get("db")
        .select()
        .from(audit)
        .where(eq(audit.profileId, p.id))
        .orderBy(desc(audit.createdAt))
        .limit(200),
    });
  });
  app.get("/v1/export", async (c) => {
    const service = c.get("service"),
      id = c.get("user").id;
    c.header("Content-Disposition", 'attachment; filename="deadmans-switch-export.json"');
    return c.json({
      exportedAt: now(),
      switch: await service.status(id),
      recipients: await service.listRecipients(id),
      messages: await service.listMessages(id),
    });
  });
  app.delete("/v1/me", async (c) => {
    deleteAccountSchema.parse(await c.req.json());
    await c
      .get("db")
      .delete(user)
      .where(eq(user.id, c.get("user").id));
    return c.body(null, 204);
  });
  app.use("/internal/*", async (c, next) => {
    const supplied = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    if (!(await secretEqual(supplied, c.get("config").OPERATIONS_SECRET)))
      throw new AppError(401, "UNAUTHORIZED");
    await next();
  });
  app.post("/internal/probe", async (c) => {
    await probe(c.get("db"), now());
    return c.json({ ok: true });
  });
  app.get("/internal/status", async (c) =>
    c.json({
      health: (await c.get("db").select().from(systemHealth))[0] ?? null,
      pending: await c
        .get("db")
        .select({
          id: outbox.id,
          kind: outbox.kind,
          state: outbox.state,
          createdAt: outbox.createdAt,
        })
        .from(outbox)
        .where(inArray(outbox.state, ["pending", "uncertain", "failed"]))
        .limit(100),
    }),
  );
  app.post("/internal/recover", async (c) => {
    await c.get("db").transaction(
      async (tx) => {
        const h = requireValue(
          (await tx.select().from(systemHealth).where(eq(systemHealth.id, "scheduler")))[0],
        );
        if (
          !h.lastProbeAt ||
          !h.lastTickAt ||
          now() - h.lastProbeAt > 300_000 ||
          now() - h.lastTickAt > 300_000
        )
          throw new AppError(503, "MONITORING_UNHEALTHY");
        await tx
          .update(systemHealth)
          .set({ incidentAt: null, recoveredAt: now() })
          .where(eq(systemHealth.id, "scheduler"));
        // Profiles remain held. Only explicit owner activation may restart them.
      },
      { behavior: "immediate" },
    );
    return c.json({ recovered: true });
  });
  app.post("/internal/tick", async (c) => {
    await billing(c.get("db"), c.get("config")).refreshDue();
    await tick(c.get("db"), c.get("config"), now());
    await dispatch(
      c.get("db"),
      c.get("config"),
      c.get("service").vault,
      deps.transport ?? notificationTransport(c.get("config")),
      now(),
    );
    await pollExpoReceipts(c.get("db"), c.get("config"), fetch, now());
    return c.json({ ok: true });
  });
  app.post("/webhooks/events", async (c) => {
    const raw = await c.req.text(),
      timestamp = c.req.header("X-Timestamp") ?? "",
      signature = c.req.header("X-Signature") ?? "";
    if (
      !/^\d+$/.test(timestamp) ||
      Math.abs(now() - Number(timestamp)) > 300_000 ||
      !(await verifySignature(c.get("config").WEBHOOK_SECRET, `${timestamp}.${raw}`, signature))
    )
      throw new AppError(401, "INVALID_SIGNATURE");
    const event = webhookSchema.parse(JSON.parse(raw));
    if (event.type === "entitlement" && c.get("config").APP_ENV === "production")
      throw new AppError(403, "STORE_VERIFICATION_REQUIRED");
    await c.get("db").transaction(
      async (tx) => {
        const inserted = await tx
          .insert(webhookEvents)
          .values({ id: event.id, createdAt: now() })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length) return;
        if (event.type === "delivery") {
          requireValue(
            (
              await tx.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, event.outboxId))
            )[0],
          );
          await recordResult(tx, event.outboxId, event, now());
          return;
        }
        const p = requireValue(
          (await tx.select().from(profiles).where(eq(profiles.userId, event.userId)))[0],
        );
        const previous = (
          await tx.select().from(entitlements).where(eq(entitlements.profileId, p.id))
        )[0];
        if (previous && previous.sourceVersion >= event.sourceVersion) return;
        const values = {
          profileId: p.id,
          plan: event.plan,
          status: event.status,
          validUntil: event.validUntil,
          sourceVersion: event.sourceVersion,
        };
        await tx
          .insert(entitlements)
          .values(values)
          .onConflictDoUpdate({ target: entitlements.profileId, set: values });
        if (!isEntitled(values, now()) && ["active", "grace", "released"].includes(p.state))
          await invalidate(tx, p, "held", now(), "entitlement_inactive");
        await log(tx, p, "entitlement_updated", now());
      },
      { behavior: "immediate" },
    );
    return c.json({ received: true });
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: { code: error.code } }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: { code: "INVALID_REQUEST" } }, 400);
    // Do not expose database errors, addresses, message bodies, or authentication URLs.
    return c.json({ error: { code: "SERVICE_UNAVAILABLE" } }, 503);
  });
  return app;
}
export const app = createApp();
