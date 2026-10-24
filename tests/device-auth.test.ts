import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { fixture, type Fixture } from "./helpers";
import type { VerifiedSubscription } from "../src/integrations/stores";
import {
  deviceCredentials,
  devices,
  contactVerifications,
  entitlements,
  outbox,
  user,
} from "../src/db/schema";
import { DeviceAuthService } from "../src/services/device-auth";
import type { Notice } from "../src/services/notifications";
import { DAY } from "../src/services/switch";
import { googleAccountHash } from "../src/integrations/store-account";
let f: Fixture;
let purchase: VerifiedSubscription;
beforeEach(async () => {
  f = await fixture({
    verify: async () => purchase,
    restore: async () => purchase,
    appleNotification: async () => ({ id: "event", reference: "purchase" }),
    googlePushAuthorization: async () => {},
  });
});
afterEach(() => f.client.close());
async function bootstrap() {
  const response = await f.request("/v1/auth/bootstrap", "POST", {});
  expect(response.status).toBe(201);
  return (await response.json()) as {
    token: string;
    accountToken: string;
    userId: string;
    expiresAt: number;
  };
}
async function subscribe(device: Awaited<ReturnType<typeof bootstrap>>) {
  purchase = {
    store: "apple",
    accountToken: device.accountToken,
    reference: "purchase",
    productId: "basic",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 30 * DAY,
  };
  expect(
    (
      await f.request(
        "/v1/billing/verify",
        "POST",
        { store: "apple", transactionId: "1234" },
        device.token,
      )
    ).status,
  ).toBe(200);
}
test("silent bootstrap cannot use application APIs until the store verifies a subscription", async () => {
  const d = await bootstrap();
  const stored = (await f.db.select().from(deviceCredentials))[0]!;
  expect(stored.tokenHash).not.toBe(d.token);
  expect((await f.request("/v1/messages", "GET", undefined, d.token)).status).toBe(403);
  expect(
    (
      await f.request(
        "/v1/recipients",
        "POST",
        { version: 1, name: "family", channel: "email", email: "family@example.jp" },
        d.token,
      )
    ).status,
  ).toBe(403);
  expect((await f.request("/v1/billing/account", "GET", undefined, d.token)).status).toBe(200);
  await subscribe(d);
  expect((await f.request("/v1/messages", "GET", undefined, d.token)).status).toBe(200);
  expect(
    (
      await f.request(
        "/v1/recipients",
        "POST",
        { version: 1, name: "family", channel: "email", email: "family@example.jp" },
        d.token,
      )
    ).status,
  ).toBe(201);
  expect((await f.request("/v1/self-test", "POST", undefined, d.token)).status).toBe(403);
  expect((await f.request("/v1/received", "POST", { token: "a".repeat(43) }, d.token)).status).toBe(
    403,
  );
  expect(await f.db.select().from(outbox)).toHaveLength(0); // No sign-in email required.
  expect((await f.db.select().from(user))[0]!.emailVerified).toBe(false);
});
test("a purchase reference cannot authenticate or take over the bound account", async () => {
  const owner = await bootstrap();
  await subscribe(owner);
  const stranger = await bootstrap();
  expect(
    (
      await f.request(
        "/v1/billing/verify",
        "POST",
        { store: "apple", transactionId: "1234" },
        stranger.token,
      )
    ).status,
  ).toBe(403);
  for (const token of ["1234", owner.accountToken, "purchase", `dms_${"a".repeat(43)}`])
    expect((await f.request("/v1/messages", "GET", undefined, token)).status).toBe(401);
});
test("expired or revoked subscriptions block existing sessions, while recovery and deletion remain available", async () => {
  const d = await bootstrap();
  await subscribe(d);
  for (const status of ["expired", "revoked"] as const) {
    await f.db
      .update(entitlements)
      .set({ status })
      .where(eq(entitlements.profileId, d.accountToken));
    expect((await f.request("/v1/messages", "GET", undefined, d.token)).status).toBe(403);
    expect((await f.request("/v1/check-ins", "POST", { kind: "foreground" }, d.token)).status).toBe(
      403,
    );
    expect((await f.request("/v1/billing/subscriptions", "GET", undefined, d.token)).status).toBe(
      200,
    );
    expect((await f.request("/v1/export", "GET", undefined, d.token)).status).toBe(200);
    expect((await f.request("/v1/switch/pause", "POST", undefined, d.token)).status).toBe(200);
  }
  expect((await f.request("/v1/me", "DELETE", { confirmation: "DELETE" }, d.token)).status).toBe(
    204,
  );
  expect(await f.db.select().from(deviceCredentials)).toHaveLength(0);
  expect((await f.request("/v1/me", "GET", undefined, d.token)).status).toBe(401);
});
test("store expiry and verification freshness are enforced even for a live device token", async () => {
  const d = await bootstrap();
  await subscribe(d);
  f.advance(DAY + 1);
  expect((await f.request("/v1/messages", "GET", undefined, d.token)).status).toBe(403);
  expect(
    (
      await f.request(
        "/v1/billing/verify",
        "POST",
        { store: "apple", transactionId: "1234" },
        d.token,
      )
    ).status,
  ).toBe(200);
  expect((await f.request("/v1/messages", "GET", undefined, d.token)).status).toBe(200);
});
test("device rotation is single-use and expired credentials cannot renew", async () => {
  const d = await bootstrap();
  const results = await Promise.all(
    [1, 2].map(() => f.request("/v1/auth/device-session", "POST", undefined, d.token)),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  const rotated = (await results.find((r) => r.status === 200)!.json()) as { token: string };
  expect((await f.request("/v1/me", "GET", undefined, d.token)).status).toBe(401);
  expect((await f.request("/v1/me", "GET", undefined, rotated.token)).status).toBe(200);
  f.advance(181 * DAY);
  expect(
    (await f.request("/v1/auth/device-session", "POST", undefined, rotated.token)).status,
  ).toBe(401);
});
test("contact verification is account-bound, encrypted, single-use and does not require a login", async () => {
  const d = await bootstrap();
  await subscribe(d);
  expect(
    (
      await f.request(
        "/v1/contact-email",
        "POST",
        { email: "owner@example.jp", name: "本人" },
        d.token,
      )
    ).status,
  ).toBe(202);
  const pending = (await f.db.select().from(contactVerifications))[0]!;
  expect(pending.email).not.toContain("owner@example.jp");
  const job = (await f.db.select().from(outbox))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  const token = notice.url!.split("#")[1]!;
  const stranger = await bootstrap();
  expect(
    (await f.request("/v1/contact-email/confirm", "POST", { token }, stranger.token)).status,
  ).toBe(400);
  expect((await f.request("/v1/contact-email/confirm", "POST", { token }, d.token)).status).toBe(
    200,
  );
  expect((await f.request("/v1/contact-email/confirm", "POST", { token }, d.token)).status).toBe(
    400,
  );
  const u = (await f.db.select().from(user).where(eq(user.id, d.userId)))[0]!;
  expect(u.email).toBe("owner@example.jp");
  expect(u.emailVerified).toBe(true);
  expect((await f.request("/v1/self-test", "POST", undefined, d.token)).status).toBe(202);
});
test("email recovery exchanges the verified session for a device token and revokes lost devices", async () => {
  const owner = await f.createUser();
  const identity = new DeviceAuthService(f.db, f.env, f.now);
  const lost = await identity.renew(owner.id);
  const response = await f.request("/v1/auth/device-session", "POST", undefined, owner.token);
  expect(response.status).toBe(200);
  const recovered = (await response.json()) as { token: string };
  expect(await identity.authenticate(lost.token)).toBeNull();
  expect((await identity.authenticate(recovered.token))?.id).toBe(owner.id);
});
test("recipient email authentication does not require the recipient to purchase a subscription", async () => {
  const receiver = await f.createUser("receiver@example.jp");
  const response = await f.request(
    "/v1/invitations/preview",
    "POST",
    { token: "a".repeat(43) },
    receiver.token,
  );
  expect(response.status).toBe(404); // Passed authentication and entitlement gate; token does not exist.
  expect((await f.request("/v1/messages", "GET", undefined, receiver.token)).status).toBe(403);
});

test("same-store restoration preserves private data without email and revokes the old device", async () => {
  const old = await bootstrap();
  await subscribe(old);
  const r = await f.service.addRecipient(old.userId, {
    version: 1,
    name: "family",
    email: "family@example.jp",
    channel: "email",
  });
  await f.service.writeMessage(old.userId, r.id, {
    version: r.version,
    title: "Private",
    body: "Original message",
  });
  await f.service.addDevice(old.userId, "ExpoPushToken[old-phone]");
  await f.service.pause(old.userId);
  const before = await f.service.status(old.userId);
  const fresh = await bootstrap();
  const restored = await f.request(
    "/v1/auth/restore",
    "POST",
    { store: "apple", signedTransaction: "verified-proof".repeat(10) },
    fresh.token,
  );
  expect(restored.status).toBe(200);
  const result = (await restored.json()) as { token: string; accountToken: string; userId: string };
  expect(result.userId).toBe(old.userId);
  expect(result.accountToken).toBe(old.accountToken);
  expect((await f.request("/v1/messages", "GET", undefined, result.token)).status).toBe(200);
  expect((await f.service.listMessages(result.userId))[0]!.body).toBe("Original message");
  expect((await f.request("/v1/me", "GET", undefined, old.token)).status).toBe(401);
  expect((await f.request("/v1/me", "GET", undefined, fresh.token)).status).toBe(401);
  expect(await f.db.select().from(user)).toHaveLength(1);
  expect((await f.db.select().from(user))[0]!.emailVerified).toBe(false);
  expect(await f.db.select().from(outbox)).toHaveLength(0);
  const after = await f.service.status(old.userId);
  expect(after.state).toBe("paused");
  expect(after.lastCheckInAt).toBe(before.lastCheckInAt);
  expect(after.version).toBe(before.version);
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "apple", signedTransaction: "verified-proof".repeat(10) },
        fresh.token,
      )
    ).status,
  ).toBe(401);
});

test("restoration requires a registered owner binding, not just the account ID chosen in a purchase", async () => {
  const victim = await bootstrap();
  await subscribe(victim);
  const fresh = await bootstrap();
  purchase = { ...purchase, reference: "attacker-purchase" };
  // A purchase made with somebody else's public appAccountToken is not an identity proof.
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "apple", signedTransaction: "verified-proof".repeat(10) },
        fresh.token,
      )
    ).status,
  ).toBe(403);
  // A valid webhook alone must not authorize that purchase for private-data recovery either.
  expect(
    (await f.request("/webhooks/apple", "POST", { signedPayload: "verified-webhook" })).status,
  ).toBe(200);
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "apple", signedTransaction: "verified-proof".repeat(10) },
        fresh.token,
      )
    ).status,
  ).toBe(403);
  expect((await f.request("/v1/me", "GET", undefined, victim.token)).status).toBe(200);
});

test("expired, revoked, deleted or mismatched store purchases cannot restore a session", async () => {
  const old = await bootstrap();
  await subscribe(old);
  const fresh = await bootstrap();
  for (const status of ["expired", "revoked"] as const) {
    purchase = { ...purchase, status };
    expect(
      (
        await f.request(
          "/v1/auth/restore",
          "POST",
          { store: "apple", signedTransaction: "verified-proof".repeat(10) },
          fresh.token,
        )
      ).status,
    ).toBe(403);
  }
  purchase = { ...purchase, status: "active" };
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "google", purchaseToken: "wrong-store-token" },
        fresh.token,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "apple", transactionId: "1234" },
        fresh.token,
      )
    ).status,
  ).toBe(400);
  await f.request("/v1/me", "DELETE", { confirmation: "DELETE" }, old.token);
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "apple", signedTransaction: "verified-proof".repeat(10) },
        fresh.token,
      )
    ).status,
  ).toBe(403);
  expect(await f.db.select().from(user)).toHaveLength(1);
});

test("Google replacement token restores through its verified linked purchase chain", async () => {
  const old = await bootstrap();
  purchase = {
    store: "google",
    reference: "old-google-token",
    accountToken: old.accountToken,
    productId: "basic:annual",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 30 * DAY,
  };
  expect(
    (
      await f.request(
        "/v1/billing/verify",
        "POST",
        { store: "google", purchaseToken: "old-google-token" },
        old.token,
      )
    ).status,
  ).toBe(200);
  purchase = { ...purchase, reference: "new-google-token", linkedReference: "old-google-token" };
  const fresh = await bootstrap();
  const response = await f.request(
    "/v1/auth/restore",
    "POST",
    { store: "google", purchaseToken: "new-google-token" },
    fresh.token,
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { userId: string }).userId).toBe(old.userId);
});

test("restore does not merge an existing different account", async () => {
  const old = await bootstrap();
  await subscribe(old);
  const other = await bootstrap();
  await f.service.pause(other.userId);
  expect(
    (
      await f.request(
        "/v1/auth/restore",
        "POST",
        { store: "apple", signedTransaction: "verified-proof".repeat(10) },
        other.token,
      )
    ).status,
  ).toBe(409);
  expect((await f.request("/v1/me", "GET", undefined, old.token)).status).toBe(200);
  expect((await f.request("/v1/me", "GET", undefined, other.token)).status).toBe(200);
});

test("Google hashed ownership verifies only its owner and restores a registered linked purchase", async () => {
  const old = await bootstrap();
  const fresh = await bootstrap();
  purchase = {
    store: "google",
    reference: "rc-google-token",
    accountToken: await googleAccountHash(old.accountToken),
    productId: "basic:annual",
    plan: "basic",
    status: "active",
    validUntil: f.now() + 30 * DAY,
  };
  const proof = { store: "google", purchaseToken: purchase.reference };
  expect((await f.request("/v1/auth/restore", "POST", proof, fresh.token)).status).toBe(403);
  expect((await f.request("/v1/billing/verify", "POST", proof, fresh.token)).status).toBe(403);
  expect((await f.request("/v1/billing/verify", "POST", proof, old.token)).status).toBe(200);
  purchase = { ...purchase, reference: "rc-replacement", linkedReference: purchase.reference };
  const response = await f.request(
    "/v1/auth/restore",
    "POST",
    { store: "google", purchaseToken: purchase.reference },
    fresh.token,
  );
  expect(response.status).toBe(200);
  const restored = (await response.json()) as {
    userId: string;
    accountToken: string;
    token: string;
  };
  expect(restored.userId).toBe(old.userId);
  expect(restored.accountToken).toBe(old.accountToken);
  expect((await f.request("/v1/me", "GET", undefined, old.token)).status).toBe(401);
  expect((await f.request("/v1/me", "GET", undefined, restored.token)).status).toBe(200);
});

test("device list contains only owned registration IDs and timestamps, with the existing five device cap", async () => {
  const owner = await bootstrap();
  const other = await bootstrap();
  await subscribe(owner);
  await f.service.addDevice(other.userId, "ExpoPushToken[other-device]");
  const expected = [];
  for (let i = 0; i < 5; i++) {
    f.advance(1);
    const device = await f.service.addDevice(owner.userId, `ExpoPushToken[owner-${i}]`);
    expected.unshift({
      id: device.id,
      createdAt: f.now(),
      name: null,
      platform: null,
      lastSeenAt: null,
      isCurrent: false,
    });
  }
  await expect(f.service.addDevice(owner.userId, "ExpoPushToken[sixth]")).rejects.toThrow(
    "DEVICE_LIMIT",
  );
  expect((await f.request("/v1/devices")).status).toBe(401);
  const response = await f.request("/v1/devices", "GET", undefined, owner.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ devices: expected });
  expect(
    (await f.request(`/v1/devices/${expected[0]!.id}`, "DELETE", undefined, owner.token)).status,
  ).toBe(204);
  const after = await f.request("/v1/devices", "GET", undefined, owner.token);
  expect(await after.json()).toEqual({ devices: expected.slice(1) });
});

test("native device list rejects cookie-only and malformed bearer fallback", async () => {
  const owner = await f.createUser();
  await f.grant(owner.profile.id);
  await f.request("/api/auth/sign-in/magic-link", "POST", {
    email: owner.email,
    callbackURL: "/recipient-auth",
  });
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "auth")))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  const verified = await f.app.request(notice.url!, {}, f.env);
  const cookie = verified.headers.get("set-cookie")!.match(/better-auth\.session_token=[^;]+/)![0];
  expect((await f.request("/v1/me", "GET", undefined, undefined, { Cookie: cookie })).status).toBe(
    200,
  );
  for (const token of [undefined, "bad.signature", " "]) {
    expect(
      (await f.request("/v1/devices", "GET", undefined, token, { Cookie: cookie })).status,
    ).toBe(401);
  }
  expect((await f.request("/v1/devices", "GET", undefined, owner.token)).status).toBe(200);
});

test("native push registration keeps its credential's ID when consolidating a legacy token", async () => {
  const owner = await bootstrap();
  const identity = new DeviceAuthService(f.db, f.env, f.now);
  const credentialId = (await identity.authenticate(owner.token))!.credentialId;
  const current = await f.service.addDevice(owner.userId, "ExpoPushToken[current]", credentialId);
  await f.service.addDevice(owner.userId, "ExpoPushToken[legacy]");
  const updated = await f.service.addDevice(owner.userId, "ExpoPushToken[legacy]", credentialId);
  expect(updated.id).toBe(current.id);
  expect(await f.db.select().from(devices)).toHaveLength(1);
});
