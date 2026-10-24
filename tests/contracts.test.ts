import { DeviceAuthService } from "../src/services/device-auth";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApiClient } from "../src/client";
import { CURRENT_CONSENT } from "../src/consents";
import {
  currentConsentSchema,
  meResponseSchema,
  switchStatusSchema,
  recipientsResponseSchema,
  selfTestResponseSchema,
  deliveriesResponseSchema,
  successResponses,
} from "../src/responses";
import { openApiDocument } from "../src/openapi";
import { fixture, type Fixture } from "./helpers";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => {
  f.client.close();
});

test("unpaid identity can get versioned consent and diagnostic status without gaining editor access", async () => {
  const client = createApiClient("http://localhost:8787", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      f.app.fetch(new Request(input, init), f.env),
  });
  const bootstrap = await client.v1.auth.bootstrap.$post({ json: {} });
  expect(bootstrap.status).toBe(201);
  const identity = await bootstrap.json();
  const options = { headers: { Authorization: `Bearer ${identity.token}` } };
  const consent = await client.v1.consents.current.$get({}, options);
  expect(currentConsentSchema.parse(await consent.json())).toEqual(CURRENT_CONSENT);
  const me = await client.v1.me.$get({}, options);
  const data = meResponseSchema.parse(await me.json());
  expect(data.switch.serverTime).toBe(f.now());
  expect(data.switch.activationBlockers).toEqual([
    "VERIFIED_EMAIL_REQUIRED",
    "ACTIVE_ENTITLEMENT_REQUIRED",
    "MONITORING_UNHEALTHY",
    "SELF_TEST_REQUIRED",
    "RECIPIENTS_NOT_READY",
  ]);
  expect((await client.v1.recipients.$get({}, options)).status).toBe(403);
  expect((await f.request("/v1/consents/current")).status).toBe(401);
});

test("actual paid success responses agree with OpenAPI schemas and Hono Client typing", async () => {
  const { owner } = await f.ready();
  const native = await new DeviceAuthService(f.db, f.env, f.now).renew(owner.id);
  for (const [path, schema] of Object.entries(successResponses)) {
    if (!path.startsWith("get /v1/") || path.includes("{")) continue;
    const response = await f.request(path.slice(4), "GET", undefined, native.token);
    expect(response.status).toBe(200);
    expect(schema.safeParse(await response.json()).success).toBe(true);
  }
  const before = switchStatusSchema.parse(
    await (await f.request("/v1/switch", "GET", undefined, owner.token)).json(),
  );
  expect(before.activationBlockers).toEqual(["PAUSE_BEFORE_EDITING"]);
  const paused = await f.service.pause(owner.id);
  expect((await f.service.status(owner.id)).activationBlockers).toEqual([]);
  const stale = await f.request(
    "/v1/switch/activate",
    "POST",
    { version: paused.version, confirmed: true, consentVersion: "2026-10-13-v1" },
    owner.token,
  );
  expect(stale.status).toBe(422);
  expect(await stale.json()).toEqual({ error: { code: "CONSENT_VERSION_REQUIRED" } });
  expect((await f.service.status(owner.id)).state).toBe("paused");
});

test("invitation timing never exposes a token and self-test response tracks an actual pending ledger row", async () => {
  const { owner } = await f.ready();
  const paused = await f.service.pause(owner.id);
  const created = await f.service.addRecipient(owner.id, {
    version: paused.version,
    name: "友人",
    email: "friend@example.jp",
    channel: "email",
  });
  await f.service.invite(owner.id, created.id);
  const list = recipientsResponseSchema.parse(
    await (await f.request("/v1/recipients", "GET", undefined, owner.token)).json(),
  );
  expect(list.recipients.find((r) => r.id === created.id)).toMatchObject({
    nextInvitationAt: f.now() + 86_400_000,
    invitationExpiresAt: f.now() + 7 * 86_400_000,
  });
  const queued = await f.request("/v1/self-test", "POST", undefined, owner.token);
  expect(queued.status).toBe(202);
  const testNotice = selfTestResponseSchema.parse(await queued.json());
  const ledger = deliveriesResponseSchema.parse(
    await (await f.request("/v1/deliveries", "GET", undefined, owner.token)).json(),
  );
  expect(ledger.deliveries.find((d) => d.id === testNotice.deliveryId)).toMatchObject({
    kind: "self_test",
    state: "pending",
  });
  expect(JSON.stringify(ledger)).not.toContain("token");
});

test("every documented JSON application success has a machine-readable response schema", () => {
  for (const [path, operations] of Object.entries(openApiDocument.paths)) {
    if (!path.startsWith("/v1/")) continue;
    for (const operation of Object.values(operations)) {
      const responses = (operation as { responses: Record<string, { content?: unknown }> })
        .responses;
      for (const [status, value] of Object.entries(responses)) {
        if (status === "default" || status === "204") continue;
        expect(value.content).toBeDefined();
      }
    }
  }
});

// Compile-time checks: input requirements must survive Hono route registration.
function typedInputContract(client: ReturnType<typeof createApiClient>) {
  // @ts-expect-error explicit action and consent are mandatory
  void client.v1.received.$post({ json: { token: "token" } });
  // @ts-expect-error background receipt is never a check-in
  void client.v1["check-ins"].$post({ json: { kind: "background" } });
}
void typedInputContract;

test("malformed JSON keeps the stable sanitized application error", async () => {
  const response = await f.app.request(
    "http://localhost:8787/v1/auth/bootstrap",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{private broken" },
    f.env,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
});
