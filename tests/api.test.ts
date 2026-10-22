import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { entitlements, outbox, profiles, user } from "../src/db/schema";
import { sign } from "../src/lib/crypto";
import type { Notice } from "../src/services/notifications";
import { fixture, type Fixture } from "./helpers";
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => f.client.close());
test("owner endpoints require a verified session", async () => {
  expect((await f.request("/v1/me")).status).toBe(401);
});
test("magic link registers passwordlessly, reuses account, and is single-use", async () => {
  const login = await f.request("/api/auth/sign-in/magic-link", "POST", {
    email: "login@example.jp",
    callbackURL: "http://localhost:3000/return",
  });
  expect(login.status).toBe(200);
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "auth")))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  const verified = await f.app.request(notice.url!, {}, f.env);
  expect(verified.status).toBe(302);
  const cookies = verified.headers.get("set-cookie");
  expect(cookies).toContain("better-auth.session_token");
  expect((await f.db.select().from(user)).length).toBe(1);
  const replay = await f.app.request(notice.url!, {}, f.env);
  expect(replay.headers.get("location")).toContain("error=");
  expect(
    (
      await f.request("/api/auth/sign-up/email", "POST", {
        email: "login@example.jp",
        password: "unused-password",
        name: "test",
      })
    ).status,
  ).not.toBe(200);
});
test("foreign recipients and messages are inaccessible", async () => {
  const { owner, recipientId } = await f.ready();
  const other = await f.createUser("other@example.jp");
  await f.grant(other.profile.id);
  const response = await f.request(
    `/v1/recipients/${recipientId}/message`,
    "PUT",
    { version: other.profile.version, title: "attack", body: "attack" },
    other.token,
  );
  expect(response.status).toBe(404);
  const list = await f.request("/v1/messages", "GET", undefined, other.token);
  expect(await list.json()).toEqual({ messages: [] });
  expect((await f.service.listMessages(owner.id))[0]!.body).toBe("家族への機密メッセージ");
});
test("background and delivery receipt events never count as check-ins", async () => {
  const { owner } = await f.ready();
  const before = await f.service.status(owner.id);
  for (const kind of ["background", "push_delivered", "automatic"]) {
    expect((await f.request("/v1/check-ins", "POST", { kind }, owner.token)).status).toBe(400);
  }
  expect((await f.service.status(owner.id)).lastCheckInAt).toBe(before.lastCheckInAt);
});
test("valid check-in uses server time and rejects extra client timestamp", async () => {
  const { owner } = await f.ready();
  expect(
    (await f.request("/v1/check-ins", "POST", { kind: "foreground", timestamp: 999 }, owner.token))
      .status,
  ).toBe(400);
  const response = await f.request("/v1/check-ins", "POST", { kind: "foreground" }, owner.token);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { lastCheckInAt: number }).lastCheckInAt).toBe(f.now());
});
test("Phase one rejects SMS, untrusted origins and oversized input", async () => {
  const owner = await f.createUser();
  await f.grant(owner.profile.id);
  for (const extra of [{ channel: "sms" }, { channel: "email", phone: "+819012345678" }]) {
    const response = await f.request(
      "/v1/recipients",
      "POST",
      {
        version: 1,
        name: "x",
        email: "x@example.jp",
        ...extra,
      },
      owner.token,
    );
    expect(response.status).toBe(400);
  }
  expect(
    (
      await f.request(
        "/v1/recipients",
        "POST",
        { version: 1, name: "x", channel: "sms", email: "x@example.jp", phone: "+819012345678" },
        owner.token,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request("/v1/check-ins", "POST", { kind: "foreground" }, owner.token, {
        Origin: "https://attacker.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/check-ins", "POST", { kind: "foreground" }, owner.token, {
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.request("/v1/check-ins", "POST", { large: "a".repeat(140_000) }, owner.token)).status,
  ).toBe(413);
});
test("billing webhooks are signed, replay-safe, and reject stale updates", async () => {
  const owner = await f.createUser();
  const event = {
    id: "event-1",
    type: "entitlement",
    userId: owner.id,
    plan: "basic",
    status: "active",
    validUntil: f.now() + 999_999,
    sourceVersion: 2,
  };
  expect((await f.request("/webhooks/events", "POST", event)).status).toBe(401);
  async function send(body: typeof event) {
    const timestamp = String(f.now());
    return f.request("/webhooks/events", "POST", body, undefined, {
      "X-Timestamp": timestamp,
      "X-Signature": await sign(f.env.WEBHOOK_SECRET, `${timestamp}.${JSON.stringify(body)}`),
    });
  }
  expect((await send(event)).status).toBe(200);
  expect((await send(event)).status).toBe(200);
  expect((await send({ ...event, id: "old", status: "expired", sourceVersion: 1 })).status).toBe(
    200,
  );
  expect((await f.db.select().from(entitlements))[0]!.status).toBe("active");
});
test("deleting account cascades private data and revokes session", async () => {
  const { owner } = await f.ready();
  expect(
    (await f.request("/v1/me", "DELETE", { confirmation: "DELETE" }, owner.token)).status,
  ).toBe(204);
  expect((await f.db.select().from(profiles)).length).toBe(0);
  expect((await f.db.select().from(outbox)).length).toBe(0);
  expect((await f.request("/v1/me", "GET", undefined, owner.token)).status).toBe(401);
});
test("operations cannot be called by an ordinary owner", async () => {
  const owner = await f.createUser();
  expect((await f.request("/internal/tick", "POST", undefined, owner.token)).status).toBe(401);
});

test("production geo restriction trusts Worker metadata, not request headers", async () => {
  const production = {
    ...f.env,
    APP_ENV: "production" as const,
    NOTIFICATION_DRIVER: "native" as const,
    EMAIL_FROM: "App <notice@example.jp>",
    BETTER_AUTH_URL: "https://api.example.jp",
    TRUSTED_ORIGINS: "https://example.jp",
    RECIPIENT_WEB_URL: "https://example.jp",
    NOTIFICATION_GATEWAY_URL: "https://notify.example.jp",
  };
  const spoof = new Request("https://api.example.jp/health/ready", {
    headers: { "CF-IPCountry": "JP" },
  });
  expect((await f.app.fetch(spoof, production)).status).toBe(403);
  const japanese = new Request("https://api.example.jp/health/ready");
  Object.defineProperty(japanese, "cf", { value: { country: "JP" } });
  expect((await f.app.fetch(japanese, production)).status).toBe(200);
});
test("magic link forbids an attacker-controlled redirect", async () => {
  const response = await f.request("/api/auth/sign-in/magic-link", "POST", {
    email: "test@example.jp",
    callbackURL: "https://attacker.example/steal",
  });
  expect(response.status).toBe(403);
});
