import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { fixture, type Fixture } from "./helpers";
import { DeviceAuthService } from "../src/services/device-auth";
import { EmailChangeService } from "../src/services/email-change";
import {
  authLinkBindings,
  deviceCredentials,
  devices,
  emailChanges,
  outbox,
  session,
  user,
} from "../src/db/schema";
import { createAuth, validSession } from "../src/auth";
import { hash } from "../src/lib/crypto";
import type { Notice } from "../src/services/notifications";
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => f.client.close());
async function setup() {
  const owner = await f.createUser();
  const identity = new DeviceAuthService(f.db, f.env, f.now);
  const native = await identity.renew(owner.id);
  const credential = (await identity.authenticate(native.token))!.credentialId;
  return {
    owner,
    identity,
    native,
    credential,
    change: new EmailChangeService(f.db, f.env, f.now),
  };
}
async function challenge(template: Notice["template"]) {
  const rows = await f.db.select().from(outbox);
  for (const row of rows.reverse()) {
    if (!row.payload) continue;
    const notice = await f.service.vault.open<Notice>(row.payload, `outbox:${row.id}`);
    if (notice.template === template) return notice.url!.split("#")[1]!;
  }
  throw new Error("Missing challenge");
}
test("both mailbox proofs are device-bound and single-use; completion revokes sessions and other devices", async () => {
  const x = await setup();
  const lost = await x.identity.bootstrap();
  // A second native credential on the same account, established before the change.
  await f.db
    .update(deviceCredentials)
    .set({ userId: x.owner.id })
    .where(eq(deviceCredentials.userId, lost.userId));
  await f.service.addDevice(x.owner.id, "ExpoPushToken[keep]", x.credential, {
    name: "Phone",
    platform: "ios",
  });
  const second = (await x.identity.authenticate(lost.token))!.credentialId;
  await f.service.addDevice(x.owner.id, "ExpoPushToken[lose]", second);
  await x.change.start(x.owner.id, x.credential, "new@example.jp");
  expect((await f.service.status(x.owner.id)).state).toBe("paused");
  expect((await f.service.status(x.owner.id)).activationBlockers).toContain("EMAIL_CHANGE_PENDING");
  const old = await challenge("email_change_old");
  await expect(x.change.confirm(x.owner.id, second, old)).rejects.toThrow(
    "INVALID_EMAIL_CHANGE_LINK",
  );
  await x.change.confirm(x.owner.id, x.credential, old);
  await expect(x.change.confirm(x.owner.id, x.credential, old)).rejects.toThrow(
    "INVALID_EMAIL_CHANGE_LINK",
  );
  const token = await challenge("email_change_new");
  await x.change.confirm(x.owner.id, x.credential, token);
  expect((await f.db.select().from(user).where(eq(user.id, x.owner.id)))[0]!.email).toBe(
    "new@example.jp",
  );
  expect(await x.identity.authenticate(lost.token)).toBeNull();
  expect(await x.identity.authenticate(x.native.token)).not.toBeNull();
  expect(await f.db.select().from(session).where(eq(session.userId, x.owner.id))).toHaveLength(0);
  expect(await f.db.select().from(devices)).toHaveLength(1);
  expect((await f.service.status(x.owner.id)).activationBlockers).toContain("SELF_TEST_REQUIRED");
  await expect(x.change.confirm(x.owner.id, x.credential, token)).rejects.toThrow(
    "INVALID_EMAIL_CHANGE_LINK",
  );
});
test("expiry, cancellation and concurrent starts cannot change the email or resume monitoring", async () => {
  const x = await setup();
  const results = await Promise.allSettled(
    ["a@example.jp", "b@example.jp"].map((e) => x.change.start(x.owner.id, x.credential, e)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const token = await challenge("email_change_old");
  const pending = (await f.db.select().from(emailChanges))[0]!;
  expect(pending.email).not.toContain("@example.jp");
  f.advance(600_001);
  await expect(x.change.confirm(x.owner.id, x.credential, token)).rejects.toThrow(
    "INVALID_EMAIL_CHANGE_LINK",
  );
  await x.change.cancel(x.owner.id, x.credential);
  expect((await f.service.status(x.owner.id)).state).toBe("paused");
  expect((await f.db.select().from(user).where(eq(user.id, x.owner.id)))[0]!.email).toBe(
    x.owner.email,
  );
});
test("a session minted after generation invalidation cannot be used or recover a device", async () => {
  const x = await setup();
  await f.db.update(user).set({ authGeneration: 1 }).where(eq(user.id, x.owner.id));
  // Simulate the final INSERT of a magic-link verification that raced the email change.
  await f.db.insert(session).values({
    id: "late",
    userId: x.owner.id,
    token: "late-session",
    authGeneration: 0,
    expiresAt: new Date(f.now() + 600_000),
    createdAt: new Date(f.now()),
    updatedAt: new Date(f.now()),
  });
  expect(
    await validSession(
      createAuth(f.db, f.env),
      f.db,
      new Headers({ Authorization: "Bearer late-session" }),
    ),
  ).toBeNull();
  await expect(x.identity.renew(x.owner.id, undefined, "late")).rejects.toThrow(
    "AUTHENTICATION_REQUIRED",
  );
  expect(await x.identity.authenticate(x.native.token)).not.toBeNull();
});
test("an old-generation mailbox proof cannot create a new-generation session", async () => {
  const x = await setup();
  await f.request("/api/auth/sign-in/magic-link", "POST", {
    email: x.owner.email,
    callbackURL: "http://localhost:3000/return",
  });
  const row = (await f.db.select().from(outbox)).at(-1)!;
  const notice = await f.service.vault.open<Notice>(row.payload, `outbox:${row.id}`);
  const token = new URL(notice.url!).searchParams.get("token")!;
  expect(
    (
      await f.db
        .select()
        .from(authLinkBindings)
        .where(eq(authLinkBindings.tokenHash, await hash(token)))
    )[0]!.generation,
  ).toBe(0);
  await f.db.update(user).set({ authGeneration: 1 }).where(eq(user.id, x.owner.id));
  const result = await f.app.request(notice.url!, {}, f.env);
  expect(result.headers.get("set-auth-token")).toBeNull();
});
test("recovery with a registered native phone clears credential linkage without losing registration", async () => {
  const x = await setup();
  await f.service.addDevice(x.owner.id, "ExpoPushToken[recover-native]", x.credential);
  await x.identity.renew(x.owner.id, undefined, (await f.db.select().from(session))[0]!.id);
  expect((await f.db.select().from(devices))[0]!.credentialId).toBeNull();
});
test("mailbox change racing email recovery cannot leave an authorized old session", async () => {
  const x = await setup();
  await x.change.start(x.owner.id, x.credential, "changed@example.jp");
  await x.change.confirm(x.owner.id, x.credential, await challenge("email_change_old"));
  const token = await challenge("email_change_new");
  const oldSession = (await f.db.select().from(session))[0]!;
  const results = await Promise.allSettled([
    x.change.confirm(x.owner.id, x.credential, token),
    x.identity.renew(x.owner.id, undefined, oldSession.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const owner = (await f.db.select().from(user).where(eq(user.id, x.owner.id)))[0]!;
  if (owner.email === "changed@example.jp")
    expect(await f.db.select().from(session).where(eq(session.userId, x.owner.id))).toHaveLength(0);
  else
    expect(
      await f.db.select().from(emailChanges).where(eq(emailChanges.userId, x.owner.id)),
    ).toHaveLength(0);
});
