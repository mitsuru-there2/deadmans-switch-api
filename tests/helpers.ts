import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { CONSENT_VERSION, DAY, SwitchService } from "../src/services/switch";
import { dispatch, enqueue, type Notice, type Transport } from "../src/services/notifications";
import type { StoreVerifier } from "../src/integrations/stores";

export async function fixture(storeVerifier?: StoreVerifier) {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  const env: Env = {
    APP_ENV: "test",
    TURSO_DATABASE_URL: "http://127.0.0.1:8080",
    TURSO_LOCATION: "local",
    BETTER_AUTH_URL: "http://localhost:8787",
    BETTER_AUTH_SECRET: "test-secret-abcdefghijklmnopqrstuvwxyz0123456789",
    TRUSTED_ORIGINS: "http://localhost:3000",
    RECIPIENT_WEB_URL: "http://localhost:3000",
    ENCRYPTION_KEYS: JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") }),
    ENCRYPTION_KEY_ID: "test",
    NOTIFICATION_GATEWAY_URL: "http://127.0.0.1:8788",
    NOTIFICATION_GATEWAY_SECRET: "gateway-secret-abcdefghijklmnopqrstuvwxyz",
    WEBHOOK_SECRET: "webhook-secret-abcdefghijklmnopqrstuvwxyz",
    OPERATIONS_SECRET: "operations-secret-abcdefghijklmnopqrstuvwxyz",
    DELIVERY_ENABLED: "true",
  };
  let time = Date.now();
  const now = () => time;
  const service = new SwitchService(db, env, now);
  const captured: Array<{ id: string; notice: Notice }> = [];
  const transport: Transport = async (id, notice) => {
    captured.push({ id, notice });
    return { state: "accepted", providerId: id };
  };
  const app = createApp({ db, now, transport, storeVerifier });
  async function createUser(email = "owner@example.jp") {
    const id = crypto.randomUUID();
    await db.insert(schema.user).values({
      id,
      name: "テスト",
      email,
      emailVerified: true,
      createdAt: new Date(time),
      updatedAt: new Date(time),
    });
    const token = crypto.randomUUID();
    await db.insert(schema.session).values({
      id: crypto.randomUUID(),
      userId: id,
      token,
      expiresAt: new Date(time + 100 * DAY),
      createdAt: new Date(time),
      updatedAt: new Date(time),
    });
    const profile = await service.profile(id);
    return { id, email, profile, token };
  }
  async function healthy() {
    await db
      .insert(schema.systemHealth)
      .values({ id: "scheduler", lastTickAt: time, lastProbeAt: time })
      .onConflictDoUpdate({
        target: schema.systemHealth.id,
        set: { lastTickAt: time, lastProbeAt: time, incidentAt: null },
      });
  }
  async function grant(profileId: string, plan: "basic" | "plus" = "basic") {
    await db.insert(schema.entitlements).values({
      profileId,
      plan,
      status: "active",
      validUntil: time + 365 * DAY,
      sourceVersion: 1,
    });
  }
  async function ready() {
    const owner = await createUser();
    await grant(owner.profile.id);
    await healthy();
    const r = await service.addRecipient(owner.id, {
      version: 1,
      name: "家族",
      email: "family@example.jp",
      channel: "email",
    });
    await service.writeMessage(owner.id, r.id, {
      version: r.version,
      title: "大切な伝言",
      body: "家族への機密メッセージ",
    });
    await service.invite(owner.id, r.id);
    const invite = (
      await db.select().from(schema.outbox).where(eq(schema.outbox.kind, "invitation"))
    )[0]!;
    const payload = await service.vault.open<Notice>(invite.payload, `outbox:${invite.id}`);
    await service.respondInvitation("family@example.jp", payload.url!.split("#")[1]!, "accept");
    await enqueue(
      db,
      service.vault,
      "self_test",
      `test:${owner.id}`,
      { channel: "email", to: owner.email, template: "self_test" },
      time,
      { profileId: owner.profile.id },
    );
    await dispatch(db, env, service.vault, transport, time);
    const status = await service.status(owner.id);
    await service.activate(owner.id, status.version, CONSENT_VERSION);
    return { owner, recipientId: r.id };
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) {
    return app.request(
      `http://localhost:8787${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  }
  return {
    client,
    db,
    env,
    now,
    service,
    captured,
    transport,
    app,
    createUser,
    healthy,
    grant,
    ready,
    request,
    advance: (duration: number) => {
      time += duration;
    },
    flush: () => dispatch(db, env, service.vault, transport, time),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
