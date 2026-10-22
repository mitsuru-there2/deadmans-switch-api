import { localEnv } from "./local-env";
import { sign } from "../src/lib/crypto";
const env = await localEnv();
const base = process.env.API_BASE_URL ?? "http://localhost:8787";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
assert(env.WEBHOOK_SECRET, "Local webhook secret must be configured");
assert((await fetch(`${base}/health/ready`)).ok, "Void Worker must reach D1");
const preflight = await fetch(`${base}/v1/auth/bootstrap`, {
  method: "OPTIONS",
  headers: {
    Origin: base,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "Content-Type",
  },
});
assert(
  preflight.status === 204 && preflight.headers.get("Access-Control-Allow-Origin") === base,
  "Void routes must preserve CORS preflight",
);
const boot = await fetch(`${base}/v1/auth/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert(boot.status === 201, `Bootstrap: ${boot.status}`);
const device = (await boot.json()) as { token: string; userId: string };
let token = device.token;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function flush() {
  const response = await fetch(`${base}/internal/tick`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPERATIONS_SECRET}` },
  });
  assert(response.ok, `Outbox: ${response.status}`);
}
async function captured(email: string, template: string) {
  const token = (await Bun.file(".void/dev-trigger-token").text()).trim();
  const headers = { "x-void-dev-trigger": token };
  const list = await (await fetch(`${base}/__void/inbox`, { headers })).text();
  const decode = (value: string) =>
    value
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  for (const match of list.matchAll(/href="(\/__void\/inbox\/[^"?]+)\?token=/g)) {
    const detail = await (await fetch(`${base}${match[1]}`, { headers })).text();
    if (!detail.includes(email)) continue;
    for (const link of decode(detail).matchAll(/href="([^"]+)"/g)) {
      const url = decode(link[1]!);
      if (template === "contact_verification" && url.includes("/confirm-contact#")) return url;
      if (template === "magic_link" && url.includes("/api/auth/magic-link/verify?")) return url;
    }
  }
  throw new Error(`Void inbox missing: ${template}`);
}
try {
  assert((await request("/v1/messages")).status === 403, "No subscription must mean no app access");
  // Local-only signed entitlement, never a store purchase or real charge.
  const timestamp = String(Date.now());
  const raw = JSON.stringify({
    id: crypto.randomUUID(),
    type: "entitlement",
    userId: device.userId,
    plan: "basic",
    status: "active",
    validUntil: Date.now() + 86_400_000,
    sourceVersion: Date.now(),
  });
  const granted = await fetch(`${base}/webhooks/events`, {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-Signature": await sign(env.WEBHOOK_SECRET, `${timestamp}.${raw}`),
    },
  });
  assert(granted.ok, `Local entitlement: ${granted.status}`);
  assert((await request("/v1/messages")).ok, "Entitlement must unlock the API without login");
  const email = `smoke-${crypto.randomUUID()}@example.jp`;
  assert(
    (await request("/v1/contact-email", "POST", { email, name: "Smoke" })).status === 202,
    "Contact request",
  );
  await flush();
  const contactUrl = await captured(email, "contact_verification");
  assert(
    (await request("/v1/contact-email/confirm", "POST", { token: contactUrl.split("#")[1] })).ok,
    "Contact verification",
  );
  const recipient = await request("/v1/recipients", "POST", {
    version: 1,
    name: "Smoke test",
    email: "recipient@example.jp",
    channel: "email",
  });
  assert(recipient.status === 201, `Recipient: ${recipient.status}`);
  const { id, version } = (await recipient.json()) as { id: string; version: number };
  assert(
    (
      await request(`/v1/recipients/${id}/message`, "PUT", {
        version,
        title: "Smoke",
        body: "Local integration verification",
      })
    ).ok,
    "Message creation",
  );
  assert((await request("/v1/export")).ok, "Export");
  const current = (await (await request("/v1/switch")).json()) as { version: number };
  const concurrent = await Promise.all(
    [30, 40].map((inactivityDays) =>
      request("/v1/switch", "PATCH", { version: current.version, inactivityDays, graceDays: 7 }),
    ),
  );
  assert(
    concurrent.filter((response) => response.status === 200).length === 1 &&
      concurrent.filter((response) => response.status === 409).length === 1,
    "D1 conflict must reject one concurrent settings change",
  );
  const login = await fetch(`${base}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email, callbackURL: `${base}/return` }),
  });
  assert(
    login.ok,
    `Recovery link request: ${login.status} ${login.ok ? "" : (await login.text()).slice(0, 500)}`,
  );
  await flush();
  const verified = await fetch(await captured(email, "magic_link"), { redirect: "manual" });
  assert(verified.status === 302, "Recovery verification");
  const recoveryToken = verified.headers.get("set-auth-token");
  assert(recoveryToken, "Recovery session");
  const exchange = await fetch(`${base}/v1/auth/device-session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${recoveryToken}` },
  });
  assert(exchange.ok, `Recovery exchange: ${exchange.status}`);
  assert((await request("/v1/me")).status === 401, "Lost device token must be revoked");
  token = ((await exchange.json()) as { token: string }).token;
  assert((await request("/v1/messages")).ok, "Recovered account data");
  console.log(
    "Void + D1 + React Email inbox: silent bootstrap, subscription gate, contact verification, encrypted messages, email recovery and device revocation passed.",
  );
} finally {
  assert(
    (await request("/v1/me", "DELETE", { confirmation: "DELETE" })).status === 204,
    "Account cleanup",
  );
}
