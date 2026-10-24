import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { sign, randomToken, Vault } from "../../src/lib/crypto";
import { successResponses } from "../../src/responses";
import { openApiDocument } from "../../src/openapi";
import type { VerifiedSubscription } from "../../src/integrations/stores";
import type { Notice } from "../../src/services/notifications";

type Identity = {
  token: string;
  userId: string;
  accountToken: string;
  email: string;
  proof: string;
};
type Captured = { id: string; notice: Notice; html: string };
export async function runSuite(
  base: string,
  env: Record<string, string | undefined>,
  sql: (statement: string) => Promise<string>,
) {
  const covered = new Set<string>();
  const day = 86_400_000;
  const specs = Object.entries(openApiDocument.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
  );
  const extra = [
    "/receive",
    "/invitations",
    "/recipient-auth",
    "/recipient-assets/style.css",
    "/recipient-assets/app.js",
    "/recipient-assets/auth.js",
    "/openapi.json",
  ].map((p) => `GET ${p}`);
  const all = [...specs, ...extra];
  function key(path: string, method: string) {
    const pathname = new URL(path, base).pathname;
    return all.find((k) => {
      const [m, p] = k.split(" ");
      return m === method && new RegExp(`^${p!.replaceAll(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname);
    });
  }
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    expected = 200,
    more: Record<string, string> = {},
  ) {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(new URL(path, base).pathname.startsWith("/api/auth/") && method === "POST"
          ? { Origin: base }
          : {}),
        "cf-connecting-ip": `e2e-${crypto.randomUUID()}`,
        ...more,
      },
      ...(body === undefined
        ? {}
        : {
            body:
              JSON.stringify(body).length > 131072
                ? new ReadableStream({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
                      controller.close();
                    },
                  })
                : JSON.stringify(body),
          }),
    });
    const text = await response.text();
    assert.equal(
      response.status,
      expected,
      `${method} ${new URL(path, base).pathname}: unexpected HTTP status`,
    );
    const k = key(path, method);
    if (k) covered.add(k);
    // Every app JSON success is checked against the public schema as well as scenario assertions.
    const schema = k ? successResponses[k.toLowerCase()] : undefined;
    const data =
      text && response.headers.get("Content-Type")?.includes("json") ? JSON.parse(text) : null;
    if (schema && expected < 300) assert(schema.safeParse(data).success, `Schema: ${k}`);
    if (new URL(path, base).pathname.startsWith("/v1/")) {
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    }
    return { response, data, text };
  }
  const ops = (path: string, method = "POST", body?: unknown, expected = 200) =>
    req(`/internal/${path}`, method, body, env.OPERATIONS_SECRET, expected);
  const control = (body?: unknown) => ops("e2e", body ? "POST" : "GET", body);
  const flush = () => ops("tick");
  async function mail(email: string, template: Notice["template"]) {
    const { data } = await control();
    const item = (data.captured as Captured[])
      .filter((x) => x.notice.to === email && x.notice.template === template)
      .at(-1);
    assert(item, `Captured ${template} missing`);
    assert(!item.html.includes("Local secret body"), "Message must never appear in mail");
    return item;
  }
  async function boot(): Promise<Identity> {
    const { data } = await req("/v1/auth/bootstrap", "POST", {}, undefined, 201);
    return {
      ...data,
      email: `e2e-${crypto.randomUUID()}@example.jp`,
      proof: `purchase-${crypto.randomUUID()}`,
    };
  }
  async function queuePush(d: Identity, deviceId: string, to: string) {
    const id = crypto.randomUUID();
    const payload = await new Vault({
      ENCRYPTION_KEYS: env.ENCRYPTION_KEYS!,
      ENCRYPTION_KEY_ID: env.ENCRYPTION_KEY_ID!,
    }).seal({ channel: "push", to, template: "reminder" }, `outbox:${id}`);
    await sql(
      `INSERT INTO outbox (id, profile_id, device_id, kind, dedupe_key, payload, available_at, created_at) VALUES ('${id}', '${d.accountToken}', '${deviceId}', 'reminder', '${id}', '${payload}', 0, ${Date.now()})`,
    );
    return id;
  }
  async function purchase(
    d: Identity,
    store: "apple" | "google" = "google",
    status: VerifiedSubscription["status"] = "active",
  ) {
    const verified: VerifiedSubscription = {
      store,
      reference: d.proof,
      accountToken: d.accountToken,
      productId: "basic:annual",
      plan: "basic",
      status,
      validUntil: Date.now() + 90 * day,
    };
    await control({ purchases: { [d.proof]: verified } });
    await req(
      "/v1/billing/verify",
      "POST",
      store === "google" ? { store, purchaseToken: d.proof } : { store, transactionId: d.proof },
      d.token,
    );
  }
  async function contact(d: Identity) {
    await req("/v1/contact-email", "POST", { email: d.email, name: "E2E Owner" }, d.token, 202);
    await flush();
    const token = (await mail(d.email, "contact_verification")).notice.url!.split("#")[1];
    await req("/v1/contact-email/confirm", "POST", { token }, d.token);
    await req("/v1/contact-email/confirm", "POST", { token }, d.token, 400);
  }
  async function owner() {
    const d = await boot();
    await purchase(d);
    await contact(d);
    return d;
  }
  async function login(email: string) {
    await req(
      "/api/auth/sign-in/magic-link",
      "POST",
      { email, callbackURL: `${base}/recipient-auth` },
      undefined,
      200,
      { Origin: base },
    );
    await flush();
    const item = await mail(email, "magic_link");
    const verified = await req(item.notice.url!, "GET", undefined, undefined, 302);
    const token = verified.response.headers.get("set-auth-token");
    assert(token);
    return {
      token,
      url: item.notice.url!,
      cookie: verified.response.headers.get("set-cookie")!.split(";")[0]!,
    };
  }
  async function status(d: Identity) {
    return (await req("/v1/switch", "GET", undefined, d.token)).data;
  }
  async function signed(event: unknown, expected = 200) {
    const timestamp = String(Date.now()),
      raw = JSON.stringify(event);
    return req("/webhooks/events", "POST", event, undefined, expected, {
      "X-Timestamp": timestamp,
      "X-Signature": await sign(env.WEBHOOK_SECRET!, `${timestamp}.${raw}`),
    });
  }
  await req("/health/live");
  await req("/health/ready");
  await req("/openapi.json");
  for (const path of extra.filter((k) => !k.endsWith("openapi.json"))) {
    const r = await req(path.slice(4));
    assert(r.text.length > 20);
  }
  await req("/internal/status", "GET", undefined, undefined, 401);
  await ops("probe");
  await flush();
  await ops("recover");
  await ops("status", "GET");
  console.log("ok health, public assets, operations and access control");

  const d = await boot();
  await req("/v1/messages", "GET", undefined, d.token, 403);
  await req("/v1/me", "GET", undefined, d.token);
  await req("/v1/consents/current", "GET", undefined, d.token);
  await req("/v1/billing/account", "GET", undefined, d.token);
  await req("/v1/billing/subscriptions", "GET", undefined, d.token);
  await req("/v1/switch", "GET", undefined, undefined, 401);
  await req("/v1/auth/bootstrap", "POST", { unknown: true }, undefined, 400);
  await purchase(d);
  await contact(d);
  await req("/v1/contact-email", "POST", { email: d.email, name: "Owner" }, d.token, 409);
  const other = await owner();
  await req(
    "/v1/recipients",
    "POST",
    { version: 1, name: "SMS", channel: "sms", phone: "+819000000000" },
    d.token,
    400,
  );
  await req("/v1/check-ins", "POST", { kind: "background" }, d.token, 400);
  await req("/v1/check-ins", "POST", { kind: "foreground", timestamp: 1 }, d.token, 400);
  await req("/v1/me", "GET", undefined, d.token, 403, { Origin: "https://untrusted.example" });
  await req(
    "/api/auth/sign-in/magic-link",
    "POST",
    { email: d.email, callbackURL: "https://evil.example" },
    undefined,
    403,
  );
  await req(
    "/v1/contact-email",
    "POST",
    { email: "a@example.jp", name: "x".repeat(132000) },
    d.token,
    413,
  );
  const initial = await status(d);
  const concurrent = await Promise.all(
    [20, 30].map((inactivityDays) =>
      fetch(`${base}/v1/switch`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: initial.version, inactivityDays, graceDays: 3 }),
      }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  covered.add("PATCH /v1/switch");
  const s = await status(d);
  await req(
    "/v1/switch/activate",
    "POST",
    { version: s.version, confirmed: true, consentVersion: s.consentVersion },
    d.token,
    422,
  );
  const receiverEmail = `receiver-${crypto.randomUUID()}@example.jp`;
  const recipient = (
    await req(
      "/v1/recipients",
      "POST",
      { version: s.version, name: "Family", channel: "email", email: receiverEmail },
      d.token,
      201,
    )
  ).data;
  const _written = (
    await req(
      `/v1/recipients/${recipient.id}/message`,
      "PUT",
      { version: recipient.version, title: "Private title", body: "Local secret body" },
      d.token,
    )
  ).data;
  await req(
    `/v1/recipients/${recipient.id}/message`,
    "PUT",
    { version: (await status(other)).version, title: "Attack", body: "Attack" },
    other.token,
    404,
  );
  await req("/v1/messages", "GET", undefined, d.token);
  await req("/v1/recipients", "GET", undefined, d.token);
  await req(`/v1/recipients/${recipient.id}/invite`, "POST", undefined, d.token, 202);
  await req(`/v1/recipients/${recipient.id}/invite`, "POST", undefined, d.token, 429);
  await flush();
  const invitation = (await mail(receiverEmail, "invitation")).notice.url!.split("#")[1];
  const receiver = await login(receiverEmail);
  await req("/v1/invitations/preview", "POST", { token: invitation }, other.token, 404);
  await req("/v1/invitations/preview", "POST", { token: invitation }, receiver.token);
  await req(
    "/v1/invitations/respond",
    "POST",
    { token: invitation, action: "accept" },
    receiver.token,
  );
  await req(
    "/v1/invitations/respond",
    "POST",
    { token: invitation, action: "accept" },
    receiver.token,
    404,
  );
  const test = (await req("/v1/self-test", "POST", undefined, d.token, 202)).data;
  await flush();
  const ledger = (await req("/v1/deliveries", "GET", undefined, d.token)).data;
  assert(
    ledger.deliveries.some(
      (x: { id: string; state: string }) => x.id === test.deliveryId && x.state === "accepted",
    ),
  );
  const deliveryEvent = {
    id: crypto.randomUUID(),
    type: "delivery",
    outboxId: test.deliveryId,
    state: "delivered",
    providerId: `e2e:${test.deliveryId}`,
  };
  await signed(deliveryEvent);
  await signed(deliveryEvent);
  await req("/webhooks/events", "POST", deliveryEvent, undefined, 401);
  await req("/v1/audit", "GET", undefined, d.token);
  const exported = await req("/v1/export", "GET", undefined, d.token);
  assert(exported.response.headers.get("Content-Disposition")?.includes("attachment"));
  assert.equal(exported.data.messages[0].body, "Local secret body");
  await ops("probe");
  await flush();
  await ops("recover");
  let current = await status(d);
  await req(
    "/v1/switch/activate",
    "POST",
    { version: current.version, confirmed: true, consentVersion: current.consentVersion },
    d.token,
  );
  await req("/v1/check-ins", "POST", { kind: "foreground" }, d.token);
  await req("/v1/check-ins", "POST", { kind: "notification_action" }, d.token);
  current = await status(d);
  await req(
    `/v1/recipients/${recipient.id}/message`,
    "PUT",
    { version: current.version, title: "x", body: "x" },
    d.token,
    409,
  );
  await sql(
    `UPDATE profiles SET last_check_in_at = ${Date.now() - 366 * day} WHERE id = '${d.accountToken}'`,
  );
  await ops("probe");
  await flush();
  assert.equal((await status(d)).state, "grace");
  await sql(
    `UPDATE profiles SET warning_accepted_at = ${Date.now() - 31 * day} WHERE id = '${d.accountToken}'`,
  );
  await ops("probe");
  await flush();
  assert.equal((await status(d)).state, "released");
  const final = (await mail(receiverEmail, "final")).notice.url!.split("#")[1];
  await req("/v1/received", "POST", { token: final }, receiver.token, 400);
  const preview = (
    await req("/v1/received", "POST", { token: final, action: "preview" }, receiver.token)
  ).data;
  assert(!("message" in preview));
  await req(
    "/v1/received",
    "POST",
    { token: final, action: "read", deathConfirmed: true, noticeVersion: "stale" },
    receiver.token,
    422,
  );
  await req("/v1/received", "POST", { token: final, action: "preview" }, other.token, 404);
  assert.equal(
    (
      await req(
        "/v1/received",
        "POST",
        {
          token: final,
          action: "read",
          deathConfirmed: true,
          noticeVersion: preview.noticeVersion,
        },
        receiver.token,
      )
    ).data.message.body,
    "Local secret body",
  );
  await sql(`UPDATE deliveries SET expires_at = 1 WHERE recipient_id = '${recipient.id}'`);
  await req("/v1/received", "POST", { token: final, action: "preview" }, receiver.token, 404);
  await req("/v1/switch/pause", "POST", undefined, d.token);
  await req(
    "/v1/received",
    "POST",
    { token: final, action: "read", deathConfirmed: true, noticeVersion: preview.noticeVersion },
    receiver.token,
    404,
  );
  await req(
    `/v1/recipient-consents/${recipient.id}/withdraw`,
    "POST",
    { action: "decline" },
    receiver.token,
  );
  current = await status(d);
  const deleted = (
    await req(
      `/v1/recipients/${recipient.id}/message`,
      "DELETE",
      { version: current.version },
      d.token,
    )
  ).data;
  await req(`/v1/recipients/${recipient.id}`, "DELETE", { version: deleted.version }, d.token);
  console.log(
    "ok paid owner, recipients, messages, invitations, release, opening, revocation and conflicts",
  );

  await sql("DELETE FROM public_rate_limits");
  await sql("DELETE FROM rate_limit");
  const registered = (
    await req(
      "/v1/devices",
      "POST",
      { token: "ExpoPushToken[e2e-current]", name: "My phone", platform: "ios" },
      d.token,
      201,
    )
  ).data;
  let listed = (await req("/v1/devices", "GET", undefined, d.token)).data.devices;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].isCurrent, true);
  assert.equal(listed[0].name, "My phone");
  assert(listed[0].lastSeenAt);
  assert(!(await req("/v1/devices", "GET", undefined, other.token)).data.devices.length);
  await req(`/v1/devices/${registered.id}`, "DELETE", undefined, other.token, 404);
  const rotated = (await req("/v1/auth/device-session", "POST", undefined, d.token)).data;
  await req("/v1/me", "GET", undefined, d.token, 401);
  d.token = rotated.token;
  assert.equal(
    (await req("/v1/devices", "GET", undefined, d.token)).data.devices[0].isCurrent,
    true,
  );
  const stalePush = await queuePush(d, registered.id, "ExpoPushToken[e2e-current]");
  assert.equal(
    (await req("/v1/devices", "POST", { token: "ExpoPushToken[e2e-rotated]" }, d.token, 201)).data
      .id,
    registered.id,
  );
  assert(
    (await req("/v1/deliveries", "GET", undefined, d.token)).data.deliveries.some(
      (x: { id: string; state: string }) => x.id === stalePush && x.state === "cancelled",
    ),
  );
  const browserOwner = await login(d.email);
  await req("/v1/devices", "GET", undefined, undefined, 401, { Cookie: browserOwner.cookie });
  await req("/v1/devices", "GET", undefined, "invalid", 401, { Cookie: browserOwner.cookie });
  for (let n = 0; n < 4; n++)
    await req(
      "/v1/devices",
      "POST",
      { token: `ExpoPushToken[e2e-legacy-${n}]` },
      browserOwner.token,
      201,
    );
  assert.equal(
    (await req("/v1/devices", "POST", { token: "ExpoPushToken[e2e-legacy-0]" }, d.token, 201)).data
      .id,
    registered.id,
  );
  await req(
    "/v1/devices",
    "POST",
    { token: "ExpoPushToken[e2e-legacy-extra]" },
    browserOwner.token,
    201,
  );
  await req("/v1/devices", "POST", { token: "ExpoPushToken[e2e-sixth]" }, browserOwner.token, 422);
  const deletedPush = await queuePush(d, registered.id, "ExpoPushToken[e2e-legacy-0]");
  await req(`/v1/devices/${registered.id}`, "DELETE", undefined, d.token, 204);
  await flush();
  assert(
    (await req("/v1/deliveries", "GET", undefined, d.token)).data.deliveries.some(
      (x: { id: string; state: string }) => x.id === deletedPush && x.state === "cancelled",
    ),
  );
  assert(
    !(await control()).data.captured.some(
      (x: Captured) => x.id === stalePush || x.id === deletedPush,
    ),
  );
  console.log("ok device metadata, ownership, rotation, current device and limit");

  const sessions = await login(d.email);
  const sessionInfo = (await req("/api/auth/get-session", "GET", undefined, sessions.token)).data;
  await req("/api/auth/list-sessions", "GET", undefined, sessions.token);
  const sessions2 = await login(d.email);
  await req(
    "/api/auth/revoke-session",
    "POST",
    { token: sessionInfo.session.token },
    sessions2.token,
    200,
    { Origin: base },
  );
  await req("/api/auth/get-session", "GET", undefined, sessions.token, 401);
  await req("/api/auth/revoke-other-sessions", "POST", {}, sessions2.token, 200, { Origin: base });
  await req("/api/auth/sign-out", "POST", {}, sessions2.token, 200, { Origin: base });
  const recovery = await login(d.email);
  const recovered = (await req("/v1/auth/device-session", "POST", undefined, recovery.token)).data;
  await req("/v1/me", "GET", undefined, d.token, 401);
  d.token = recovered.token;
  console.log("ok real Better Auth login, session management and device recovery");

  await sql("DELETE FROM public_rate_limits");
  await sql("DELETE FROM rate_limit");
  const newEmail = `changed-${crypto.randomUUID()}@example.jp`;
  const oldRecovery = await login(d.email);
  await req("/api/auth/sign-in/magic-link", "POST", {
    email: d.email,
    callbackURL: `${base}/recipient-auth`,
  });
  await flush();
  const oldUnredeemed = (await mail(d.email, "magic_link")).notice.url!;
  await req("/v1/contact-email/change", "POST", { email: newEmail, confirmed: true }, d.token, 202); // Deliberately discard the start result.
  assert.equal(
    (await req("/v1/contact-email/change", "GET", undefined, d.token)).data.change.email,
    newEmail,
  );
  assert.equal((await status(d)).state, "paused");
  await req("/v1/contact-email/change", "POST", { email: newEmail, confirmed: true }, d.token, 409);
  await flush();
  const oldChallenge = (await mail(d.email, "email_change_old")).notice.url!.split("#")[1];
  await req("/v1/contact-email/change/confirm", "POST", { token: oldChallenge }, other.token, 400);
  await req("/v1/contact-email/change/confirm", "POST", { token: oldChallenge }, d.token);
  await req("/v1/contact-email/change/confirm", "POST", { token: oldChallenge }, d.token, 400);
  await flush();
  const newChallenge = (await mail(newEmail, "email_change_new")).notice.url!.split("#")[1];
  await req("/v1/contact-email/change/confirm", "POST", { token: newChallenge }, d.token); // Deliberately discard completion result.
  assert.equal((await req("/v1/me", "GET", undefined, d.token)).data.user.email, newEmail);
  assert.equal(
    (await req("/v1/contact-email/change", "GET", undefined, d.token)).data.change,
    null,
  );
  assert((await status(d)).activationBlockers.includes("SELF_TEST_REQUIRED"));
  await req("/api/auth/get-session", "GET", undefined, oldRecovery.token, 401);
  const replay = await req(oldUnredeemed, "GET", undefined, undefined, 302);
  assert(replay.response.headers.get("Location")?.includes("error="));
  await req("/v1/contact-email/change/confirm", "POST", { token: newChallenge }, d.token, 400);
  await flush();
  await mail(newEmail, "email_change_complete");
  await mail(d.email, "email_change_complete");
  d.email = newEmail;
  await req("/v1/self-test", "POST", undefined, d.token, 202);
  await flush();
  assert(!(await status(d)).activationBlockers.includes("SELF_TEST_REQUIRED"));
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: other.email, confirmed: true },
    d.token,
    409,
  );
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: other.email, confirmed: true },
    d.token,
    429,
  );
  // Separate owner for cancellation, expiry, provider failure and subscription-free account control.
  const changer = await owner();
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: other.email, confirmed: true },
    changer.token,
    409,
  );
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: `cancel-${crypto.randomUUID()}@example.jp`, confirmed: true },
    changer.token,
    202,
  );
  await req("/v1/contact-email/change", "DELETE", undefined, changer.token, 204);
  assert.equal((await status(changer)).state, "paused");
  await control({ result: "failed" });
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: `expire-${crypto.randomUUID()}@example.jp`, confirmed: true },
    changer.token,
    202,
  );
  await flush();
  const expired = (await mail(changer.email, "email_change_old")).notice.url!.split("#")[1];
  await sql(`UPDATE email_changes SET expires_at = 1 WHERE user_id = '${changer.userId}'`);
  await req("/v1/contact-email/change/confirm", "POST", { token: expired }, changer.token, 400);
  assert.equal(
    (await req("/v1/contact-email/change", "GET", undefined, changer.token)).data.change,
    null,
  );
  await control({ result: "accepted" });
  await sql(
    `UPDATE entitlements SET status = 'expired' WHERE profile_id = '${changer.accountToken}'`,
  );
  await req("/v1/contact-email/change", "GET", undefined, changer.token);
  await req("/v1/contact-email/change", "DELETE", undefined, changer.token, 204);
  await sql("DELETE FROM public_rate_limits");
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: `unpaid-${crypto.randomUUID()}@example.jp`, confirmed: true },
    changer.token,
    202,
  );
  await req("/v1/contact-email/change", "DELETE", undefined, changer.token, 204);
  console.log(
    "ok email change, dual proof, old session/link revocation, self-test reset, expiry, cancel and response loss",
  );

  await sql("DELETE FROM rate_limit");
  const racer = await owner();
  const raceRecovery = await login(racer.email);
  const raceEmail = `race-${crypto.randomUUID()}@example.jp`;
  await req(
    "/v1/contact-email/change",
    "POST",
    { email: raceEmail, confirmed: true },
    racer.token,
    202,
  );
  const pendingStatus = await status(racer);
  await req(
    "/v1/switch/activate",
    "POST",
    {
      version: pendingStatus.version,
      confirmed: true,
      consentVersion: pendingStatus.consentVersion,
    },
    racer.token,
    422,
  );
  await flush();
  await req(
    "/v1/contact-email/change/confirm",
    "POST",
    { token: (await mail(racer.email, "email_change_old")).notice.url!.split("#")[1] },
    racer.token,
  );
  await flush();
  const raceProof = (await mail(raceEmail, "email_change_new")).notice.url!.split("#")[1];
  const raceResponses = await Promise.all([
    fetch(`${base}/v1/contact-email/change/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${racer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: raceProof }),
    }),
    fetch(`${base}/v1/auth/device-session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${raceRecovery.token}` },
    }),
  ]);
  assert.deepEqual(raceResponses.map((r) => r.status).sort(), [200, 401]);
  if (raceResponses[0]!.status === 200) {
    assert.equal((await req("/v1/me", "GET", undefined, racer.token)).data.user.email, raceEmail);
    await req("/api/auth/get-session", "GET", undefined, raceRecovery.token, 401);
  } else {
    const replacement = (await raceResponses[1]!.json()) as { token: string };
    assert.equal(
      (await req("/v1/contact-email/change", "GET", undefined, replacement.token)).data.change,
      null,
    );
  }
  console.log("ok concurrent email change versus recovery on real D1");

  const restoreSource = await owner();
  const fresh = await boot();
  const operationSecret = randomToken();
  const restored = (
    await req(
      "/v1/auth/restore",
      "POST",
      { store: "google", purchaseToken: restoreSource.proof, operationSecret },
      fresh.token,
    )
  ).data;
  const result = (await req("/v1/auth/restore/result", "POST", { operationSecret }, fresh.token))
    .data;
  assert.equal(result.session.token, restored.token);
  await req("/v1/me", "GET", undefined, restoreSource.token, 401);
  await req(
    "/v1/auth/restore/result",
    "POST",
    { operationSecret: randomToken() },
    fresh.token,
    404,
  );
  await req("/v1/auth/restore/result", "POST", { operationSecret }, restored.token, 404);
  await req(
    "/v1/auth/restore",
    "POST",
    { store: "apple", transactionId: "123" },
    restored.token,
    400,
  );
  await req("/webhooks/apple", "POST", { signedPayload: "forged" }, undefined, 401);
  // Apple purchase verification uses a numeric reference; the external boundary supplies verified evidence.
  const apple = await boot();
  apple.proof = String(Date.now());
  await purchase(apple, "apple");
  await req("/webhooks/apple", "POST", { signedPayload: `valid:${apple.proof}` });
  await req("/webhooks/apple", "POST", { signedPayload: `valid:${apple.proof}` });
  const googleEvent = {
    message: {
      messageId: crypto.randomUUID(),
      data: Buffer.from(
        JSON.stringify({
          packageName: "jp.example",
          subscriptionNotification: { purchaseToken: restoreSource.proof, notificationType: 2 },
        }),
      ).toString("base64"),
    },
  };
  await req("/webhooks/google", "POST", googleEvent, "forged", 401);
  await req("/webhooks/google", "POST", googleEvent, "e2e-valid");
  await req("/webhooks/google", "POST", googleEvent, "e2e-valid");
  await req("/v1/auth/device-sessions", "DELETE", undefined, restored.token, 204);
  await req("/v1/me", "GET", undefined, restored.token, 401);
  console.log(
    "ok purchase, same-store restore, lost result retrieval and signed webhook deduplication",
  );

  await req("/v1/me", "DELETE", { confirmation: "wrong" }, d.token, 400);
  await req("/v1/me", "DELETE", { confirmation: "DELETE" }, d.token, 204);
  await req("/v1/me", "GET", undefined, d.token, 401);
  const deletedRows = await sql(
    `SELECT count(*) AS remaining FROM profiles WHERE user_id = '${d.userId}'`,
  );
  assert(deletedRows.includes("0"));
  // OPTIONS is shared middleware, exercised on every declared Void route with the actual method.
  const routeEntries: string[] = [];
  async function scan(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      if (!path.endsWith(".ts") || path.endsWith(".dev.ts")) continue;
      const source = await readFile(path, "utf8");
      if (path.includes("[...path]")) continue;
      const route = path.slice("routes".length, -3).replaceAll(/\[([^\]]+)\]/g, "{$1}");
      for (const match of source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)) {
        const method = match[1]!;
        if (method === "OPTIONS") {
          const response = await fetch(`${base}${route.replaceAll(/\{[^}]+\}/g, "missing")}`, {
            method,
            headers: { Origin: base, "Access-Control-Request-Method": "POST" },
          });
          assert.equal(response.status, 204, `OPTIONS ${route}`);
        } else routeEntries.push(`${method} ${route}`);
      }
    }
  }
  await scan("routes");
  const missing = [...new Set([...all, ...routeEntries])].filter((k) => !covered.has(k));
  assert.deepEqual(missing, [], `Missing endpoint tests: ${missing.join(", ")}`);
  const manifest = [...covered].sort();
  await Bun.write(
    ".local/e2e-coverage.json",
    JSON.stringify(
      { database: "Void local D1", endpointCount: manifest.length, endpoints: manifest },
      null,
      2,
    ),
  );
  console.log(
    `E2E passed: ${manifest.length} method/path contracts, real HTTP + Void D1; no database mocks.`,
  );
}
