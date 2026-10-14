import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { deviceCredentials, restoreOperations } from "../src/db/schema";
import type { VerifiedSubscription } from "../src/integrations/stores";
import { randomToken, Vault } from "../src/lib/crypto";
import { AppError } from "../src/lib/errors";
import type { BootstrapResponse, RestoreResultResponse } from "../src/responses";
import { DeviceAuthService } from "../src/services/device-auth";
import { purgeRestoreResults, RESTORE_RESULT_TTL } from "../src/services/restore-operations";
import { DAY } from "../src/services/switch";
import { fixture, type Fixture } from "./helpers";

let f: Fixture;
let purchase: VerifiedSubscription;
let onRestore: () => Promise<VerifiedSubscription>;
let storeCalls: number;
beforeEach(async () => {
  storeCalls = 0;
  onRestore = async () => purchase;
  f = await fixture({
    verify: async () => purchase,
    restore: async () => {
      storeCalls++;
      return onRestore();
    },
    appleNotification: async () => ({ id: "unused" }),
    googlePushAuthorization: async () => {},
  });
});
afterEach(() => f.client.close());
async function bootstrap() {
  const r = await f.request("/v1/auth/bootstrap", "POST", {});
  expect(r.status).toBe(201);
  return (await r.json()) as BootstrapResponse;
}
async function setup(store: "apple" | "google" = "google") {
  const owner = await bootstrap();
  purchase = {
    store,
    reference: "registered-purchase",
    accountToken: owner.accountToken,
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
        store === "google"
          ? { store, purchaseToken: purchase.reference }
          : { store, transactionId: "1234567890" },
        owner.token,
      )
    ).status,
  ).toBe(200);
  const fresh = await bootstrap();
  const secret = randomToken();
  const body =
    store === "google"
      ? { store, purchaseToken: purchase.reference, operationSecret: secret }
      : { store, signedTransaction: "mock-storekit-jws".repeat(10), operationSecret: secret };
  const restore = () => f.request("/v1/auth/restore", "POST", body, fresh.token);
  const result = (token = fresh.token, operationSecret = secret) =>
    f.request("/v1/auth/restore/result", "POST", { operationSecret }, token);
  return { owner, fresh, secret, body, restore, result };
}
function blockedStore() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  onRestore = async () => {
    entered();
    await gate;
    return purchase;
  };
  return { waiting, release };
}

test("lost response retrieves exactly one encrypted result using both preexisting secrets", async () => {
  const s = await setup();
  const before = await f.service.profile(s.owner.userId);
  const response = await s.restore();
  expect(response.status).toBe(200);
  const original = (await response.json()) as BootstrapResponse;
  expect((await f.request("/v1/me", "GET", undefined, s.owner.token)).status).toBe(401);
  expect((await f.request("/v1/me", "GET", undefined, s.fresh.token)).status).toBe(401);
  const row = (await f.db.select().from(restoreOperations))[0]!;
  expect(JSON.stringify(row)).not.toContain(original.token);
  expect(JSON.stringify(row)).not.toContain(s.fresh.token);
  expect(JSON.stringify(row)).not.toContain(s.secret);
  expect(JSON.stringify(row)).not.toContain(purchase.reference);
  expect(row.result).toStartWith("test.");
  for (let n = 0; n < 2; n++) {
    const r = await s.result();
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(await r.json()).toEqual({
      status: "completed",
      session: original,
      expiresAt: row.expiresAt,
    });
  }
  expect(storeCalls).toBe(1);
  expect(await f.db.select().from(deviceCredentials)).toHaveLength(1);
  expect(await f.service.profile(s.owner.userId)).toEqual(before);
  expect((await s.restore()).status).toBe(401); // No ordinary bearer replay.
});

test("wrong secret, old owner, other fresh device, new bearer and public IDs cannot retrieve credentials", async () => {
  const s = await setup();
  const completed = (await (await s.restore()).json()) as BootstrapResponse;
  const other = await bootstrap();
  for (const token of [s.owner.token, other.token, completed.token, "invalid"])
    expect((await s.result(token)).status).toBe(404);
  expect((await s.result(s.fresh.token, randomToken())).status).toBe(404);
  expect(
    (await f.request("/v1/auth/restore/result", "POST", { operationSecret: s.secret })).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        "/v1/auth/restore/result",
        "POST",
        { operationSecret: s.fresh.accountToken },
        s.fresh.token,
      )
    ).status,
  ).toBe(400);
  expect((await f.request("/v1/auth/restore/result", "GET", undefined, s.fresh.token)).status).toBe(
    401,
  );
});

test("Apple full-JWS restoration also returns the same saved result without resubmitting JWS", async () => {
  const s = await setup("apple");
  const response = await s.restore();
  expect(response.status).toBe(200);
  const original = await response.json();
  expect(await (await s.result()).json()).toMatchObject({ status: "completed", session: original });
  expect(storeCalls).toBe(1);
});

test("operation-enabled restore rejects a non-fresh subscribed owner before store verification", async () => {
  const s = await setup();
  const response = await f.request("/v1/auth/restore", "POST", s.body, s.owner.token);
  expect(response.status).toBe(409);
  expect(storeCalls).toBe(0);
  expect(await f.db.select().from(restoreOperations)).toHaveLength(0);
});

test("operation binds one fresh credential, secret and exact purchase proof before contacting the store", async () => {
  const s = await setup(),
    gate = blockedStore();
  const pending = s.restore();
  await gate.waiting;
  expect(((await (await s.result()).json()) as RestoreResultResponse).status).toBe("pending");
  for (const body of [
    { ...s.body, purchaseToken: "another-purchase" },
    { ...s.body, operationSecret: randomToken() },
  ])
    expect((await f.request("/v1/auth/restore", "POST", body, s.fresh.token)).status).toBe(409);
  const other = await bootstrap();
  expect((await f.request("/v1/auth/restore", "POST", s.body, other.token)).status).toBe(409);
  expect(storeCalls).toBe(1);
  gate.release();
  expect((await pending).status).toBe(200);
});

test("concurrent identical operations commit one credential and return the same result", async () => {
  const s = await setup(),
    gate = blockedStore();
  const first = s.restore();
  await gate.waiting;
  const second = s.restore();
  for (let n = 0; n < 100 && storeCalls < 2; n++) await Bun.sleep(1);
  expect(storeCalls).toBe(2);
  gate.release();
  const responses = await Promise.all([first, second]);
  // SQLite can fail one contender with a transient lock error; result retrieval is the recovery path.
  const successful = responses.filter((r) => r.status === 200);
  expect(successful.length).toBeGreaterThan(0);
  expect(responses.every((r) => r.status === 200 || r.status === 503)).toBe(true);
  const original = await successful[0]!.json();
  if (successful.length > 1) expect(await successful[1]!.json()).toEqual(original);
  expect(await (await s.result()).json()).toMatchObject({ status: "completed", session: original });
  expect(await f.db.select().from(deviceCredentials)).toHaveLength(1);
});

for (const action of ["expire", "revoke-source"] as const) {
  test(`${action} during store verification cannot commit a late restore`, async () => {
    const s = await setup(),
      gate = blockedStore();
    const pending = s.restore();
    await gate.waiting;
    if (action === "expire") f.advance(RESTORE_RESULT_TTL);
    else await new DeviceAuthService(f.db, f.env, f.now).revoke(s.fresh.userId);
    gate.release();
    expect((await pending).status).toBe(action === "expire" ? 404 : 401);
    expect((await f.request("/v1/me", "GET", undefined, s.owner.token)).status).toBe(200);
    expect((await s.result()).status).toBe(404);
    expect((await f.db.select().from(restoreOperations))[0]!.result).toBeNull();
  });
}

test("a terminal rejection is observable without retrying or changing the selected proof", async () => {
  const s = await setup();
  onRestore = async () => {
    throw new AppError(403, "PURCHASE_NOT_REGISTERED");
  };
  expect((await s.restore()).status).toBe(403);
  expect(await (await s.result()).json()).toMatchObject({
    status: "failed",
    error: { code: "PURCHASE_NOT_REGISTERED" },
  });
  expect((await s.restore()).status).toBe(409);
  expect(storeCalls).toBe(1);
});

test("transient failures can retry the exact request without extending its deadline", async () => {
  const s = await setup();
  onRestore = async () => {
    throw new AppError(503, "GOOGLE_VERIFICATION_FAILED");
  };
  expect((await s.restore()).status).toBe(503);
  const first = (await (await s.result()).json()) as RestoreResultResponse;
  expect(first.status).toBe("pending");
  f.advance(100);
  onRestore = async () => purchase;
  expect((await s.restore()).status).toBe(200);
  expect(((await (await s.result()).json()) as RestoreResultResponse).expiresAt).toBe(
    first.expiresAt,
  );
});

for (const action of ["rotate", "revoke", "delete", "another-restore"] as const) {
  test(`result cannot revive a credential after ${action}`, async () => {
    const s = await setup();
    const restored = (await (await s.restore()).json()) as BootstrapResponse;
    if (action === "rotate")
      expect(
        (await f.request("/v1/auth/device-session", "POST", undefined, restored.token)).status,
      ).toBe(200);
    if (action === "revoke")
      expect(
        (await f.request("/v1/auth/device-sessions", "DELETE", undefined, restored.token)).status,
      ).toBe(204);
    if (action === "delete")
      expect(
        (await f.request("/v1/me", "DELETE", { confirmation: "DELETE" }, restored.token)).status,
      ).toBe(204);
    if (action === "another-restore") {
      const fresh = await bootstrap();
      expect(
        (
          await f.request(
            "/v1/auth/restore",
            "POST",
            { ...s.body, operationSecret: randomToken() },
            fresh.token,
          )
        ).status,
      ).toBe(200);
    }
    expect((await s.result()).status).toBe(404);
    expect((await f.request("/v1/me", "GET", undefined, restored.token)).status).toBe(401);
  });
}

test("result persistence failure rolls back all credential revocations and can safely retry", async () => {
  const s = await setup();
  const seal = Vault.prototype.seal;
  const mocked = spyOn(Vault.prototype, "seal").mockImplementation(function (
    this: Vault,
    value,
    context,
  ) {
    if (context.startsWith("restore-result:")) throw new Error("simulated storage failure");
    return seal.call(this, value, context);
  });
  try {
    expect((await s.restore()).status).toBe(503);
  } finally {
    mocked.mockRestore();
  }
  expect((await f.request("/v1/me", "GET", undefined, s.owner.token)).status).toBe(200);
  expect((await f.request("/v1/me", "GET", undefined, s.fresh.token)).status).toBe(200);
  expect((await f.db.select().from(restoreOperations))[0]!.state).toBe("pending");
  expect((await s.restore()).status).toBe(200);
});

test("TTL denies access even without Cron; cleanup removes encrypted results then tombstones", async () => {
  const s = await setup();
  expect((await s.restore()).status).toBe(200);
  f.advance(RESTORE_RESULT_TTL);
  expect((await s.result()).status).toBe(404);
  await purgeRestoreResults(f.db, f.now());
  const row = (await f.db.select().from(restoreOperations))[0]!;
  expect(row.result).toBeNull();
  expect(row.resultTokenHash).toBeNull();
  f.advance(DAY);
  await purgeRestoreResults(f.db, f.now());
  expect(await f.db.select().from(restoreOperations)).toHaveLength(0);
  expect((await s.restore()).status).toBe(401);
});

test("a result that expires during decryption is not disclosed", async () => {
  const s = await setup();
  expect((await s.restore()).status).toBe(200);
  const open = Vault.prototype.open;
  const mocked = spyOn(Vault.prototype, "open").mockImplementation(async function <T>(
    this: Vault,
    value: string,
    context: string,
  ): Promise<T> {
    const result = (await open.call(this, value, context)) as T;
    if (context.startsWith("restore-result:")) f.advance(RESTORE_RESULT_TTL);
    return result;
  });
  try {
    expect((await s.result()).status).toBe(404);
  } finally {
    mocked.mockRestore();
  }
});

test("expiry while saving the encrypted result rolls back the entire restore", async () => {
  const s = await setup();
  const seal = Vault.prototype.seal;
  const mocked = spyOn(Vault.prototype, "seal").mockImplementation(async function (
    this: Vault,
    value,
    context,
  ) {
    const result = await seal.call(this, value, context);
    if (context.startsWith("restore-result:")) f.advance(RESTORE_RESULT_TTL);
    return result;
  });
  try {
    expect((await s.restore()).status).toBe(404);
  } finally {
    mocked.mockRestore();
  }
  expect((await f.request("/v1/me", "GET", undefined, s.owner.token)).status).toBe(200);
  expect((await f.request("/v1/me", "GET", undefined, s.fresh.token)).status).toBe(200);
  expect((await f.db.select().from(restoreOperations))[0]!.result).toBeNull();
});

test("a deleted operation generation cannot be completed by an old in-flight request", async () => {
  const s = await setup(),
    gate = blockedStore();
  const pending = s.restore();
  await gate.waiting;
  const row = (await f.db.select().from(restoreOperations))[0]!;
  // Simulate cleanup/replacement while the external verifier was blocked.
  await f.db.delete(restoreOperations).where(eq(restoreOperations.id, row.id));
  await f.db.insert(restoreOperations).values({ ...row, id: crypto.randomUUID() });
  gate.release();
  expect((await pending).status).toBe(404);
  expect((await f.request("/v1/me", "GET", undefined, s.owner.token)).status).toBe(200);
});

test("cleanup revokes an abandoned fresh bearer before purging its operation tombstone", async () => {
  const s = await setup();
  onRestore = async () => {
    throw new AppError(503, "GOOGLE_VERIFICATION_FAILED");
  };
  expect((await s.restore()).status).toBe(503);
  f.advance(DAY);
  await purgeRestoreResults(f.db, f.now());
  expect(await f.db.select().from(restoreOperations)).toHaveLength(0);
  expect((await s.restore()).status).toBe(401);
  expect((await f.request("/v1/me", "GET", undefined, s.owner.token)).status).toBe(200);
});
