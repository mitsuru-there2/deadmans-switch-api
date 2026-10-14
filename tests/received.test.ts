import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deliveries, openingConsents, outbox, profiles, user } from "../src/db/schema";
import { receivedResponseSchema } from "../src/contracts";
import { type Notice } from "../src/services/notifications";
import { tick } from "../src/services/scheduler";
import { CONSENT_VERSION, DAY, OPENING_NOTICE_VERSION } from "../src/services/switch";
import { fixture, type Fixture } from "./helpers";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => {
  f.client.close();
});
async function release() {
  const ready = await f.ready();
  const recipient = await f.createUser("family@example.jp");
  f.advance(30 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  await f.flush();
  f.advance(7 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  return { ...ready, recipient, token: notice.url!.split("#")[1]!, notice };
}
const consent = { deathConfirmed: true as const, noticeVersion: OPENING_NOTICE_VERSION };
function read(token: string) {
  return { token, action: "read", ...consent };
}
async function noDisclosure(response: Response, status: number) {
  expect(response.status).toBe(status);
  const body = await response.text();
  expect(body).not.toContain("大切な伝言");
  expect(body).not.toContain("家族への機密メッセージ");
  expect(body).not.toContain('"message"');
}

test("preview and scanner GET never disclose, decrypt the snapshot or record opening consent", async () => {
  const { recipient, token, notice } = await release();
  const response = await f.request(
    "/v1/received",
    "POST",
    { token, action: "preview" },
    recipient.token,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const preview = receivedResponseSchema.parse(await response.json());
  if (!("notice" in preview)) throw new Error("Expected preview");
  expect(Object.keys(preview).sort()).toEqual([
    "expiresAt",
    "notice",
    "noticeVersion",
    "senderName",
  ]);
  expect(preview.noticeVersion).toBe(OPENING_NOTICE_VERSION);
  expect(preview.notice).toContain("死亡を確認したものではありません");
  expect(JSON.stringify(notice)).not.toContain("大切な伝言");
  expect(JSON.stringify(notice)).not.toContain("家族への機密メッセージ");
  await noDisclosure(await f.request("/v1/received", "GET", undefined, recipient.token), 404);
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
  expect((await f.db.select().from(deliveries))[0]!.viewedAt).toBeNull();
  // Even an unreadable snapshot cannot cause preview to access plaintext.
  await f.db.update(deliveries).set({ ciphertext: "unreadable" });
  expect(
    (await f.request("/v1/received", "POST", { token, action: "preview" }, recipient.token)).status,
  ).toBe(200);
});

test("missing action, consent, false consent, unknown action and stale notice never open", async () => {
  const { recipient, token } = await release();
  for (const body of [
    { token },
    { token, deathConfirmed: true },
    { token, action: "read" },
    { ...read(token), deathConfirmed: false },
    { token, action: "read", deathConfirmed: true },
    { token, action: "prefetch" },
    { token, action: "preview", ...consent },
  ])
    await noDisclosure(await f.request("/v1/received", "POST", body, recipient.token), 400);
  const stale = await f.request(
    "/v1/received",
    "POST",
    { ...read(token), noticeVersion: "old" },
    recipient.token,
  );
  expect(stale.status).toBe(422);
  expect(await stale.json()).toEqual({ error: { code: "OPENING_NOTICE_VERSION_REQUIRED" } });
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
  await expect(f.service.readDelivery(recipient.email, token, "read")).rejects.toThrow(
    "OPENING_CONSENT_REQUIRED",
  );
});

test("explicit opening binds consent to authenticated recipient and immutable revision; repeats are idempotent", async () => {
  const { recipient, token, recipientId } = await release();
  for (let n = 0; n < 2; n++) {
    const response = await f.request("/v1/received", "POST", read(token), recipient.token);
    expect(response.status).toBe(200);
    expect(receivedResponseSchema.parse(await response.json())).toMatchObject({
      message: { title: "大切な伝言", body: "家族への機密メッセージ" },
    });
  }
  const d = (await f.db.select().from(deliveries))[0]!;
  const rows = await f.db.select().from(openingConsents);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    userId: recipient.id,
    deliveryId: d.id,
    releaseId: d.releaseId,
    recipientId,
    messageRevision: 1,
    noticeVersion: OPENING_NOTICE_VERSION,
    confirmedAt: f.now(),
  });
  expect(rows[0]!.snapshotHash).not.toContain("家族への");
});

test("recipient authentication and email binding remain mandatory", async () => {
  const { recipient, token, owner } = await release();
  await noDisclosure(await f.request("/v1/received", "POST", read(token)), 401);
  for (const action of ["read", "preview"])
    await noDisclosure(
      await f.request(
        "/v1/received",
        "POST",
        action === "read" ? read(token) : { token, action },
        owner.token,
      ),
      404,
    );
  await f.db.update(user).set({ emailVerified: false }).where(eq(user.id, recipient.id));
  await noDisclosure(await f.request("/v1/received", "POST", read(token), recipient.token), 401);
});

for (const stop of ["pause", "check-in", "hold", "decline", "report", "expire"] as const) {
  test(`past opening consent cannot bypass ${stop}`, async () => {
    const { recipient, token, owner } = await release();
    expect((await f.request("/v1/received", "POST", read(token), recipient.token)).status).toBe(
      200,
    );
    if (stop === "pause") await f.service.pause(owner.id);
    if (stop === "check-in") await f.service.checkIn(owner.id, "foreground");
    if (stop === "hold")
      await f.db.update(profiles).set({ state: "held" }).where(eq(profiles.id, owner.profile.id));
    if (stop === "expire") f.advance(30 * DAY);
    if (stop === "decline" || stop === "report") {
      expect(
        (await f.request("/v1/received", "POST", { token, action: stop }, recipient.token)).status,
      ).toBe(200);
      expect((await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!.state).toBe(
        "cancelled",
      );
    }
    for (const body of [read(token), { token, action: "preview" }])
      await noDisclosure(await f.request("/v1/received", "POST", body, recipient.token), 404);
  });
}

test("decline and report work without an opening consent", async () => {
  const { recipient, token } = await release();
  expect(
    (await f.request("/v1/received", "POST", { token, action: "decline" }, recipient.token)).status,
  ).toBe(200);
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
});

test("stop committed before an opening wins; concurrent operations cannot restore disclosure", async () => {
  const { recipient, token, owner } = await release();
  const results = await Promise.allSettled([
    f.service.pause(owner.id),
    f.service.readDelivery(recipient.email, token, "read", consent),
  ]);
  expect(results[0]!.status).toBe("fulfilled");
  expect(results[1]!.status).toBe("rejected");
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
  await noDisclosure(await f.request("/v1/received", "POST", read(token), recipient.token), 404);
});

test("a new release and revised message require new consent; old link and old consent stay revoked", async () => {
  const { recipient, token, owner, recipientId } = await release();
  expect((await f.request("/v1/received", "POST", read(token), recipient.token)).status).toBe(200);
  const paused = await f.service.pause(owner.id);
  const updated = await f.service.writeMessage(owner.id, recipientId, {
    version: paused.version,
    title: "新しい伝言",
    body: "改訂本文",
  });
  await f.service.activate(owner.id, updated.version, CONSENT_VERSION);
  f.advance(30 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  await f.flush();
  f.advance(7 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  const job = (await f.db.select().from(outbox).where(eq(outbox.state, "pending"))).find(
    (x) => x.kind === "final",
  )!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  const nextToken = notice.url!.split("#")[1]!;
  await noDisclosure(await f.request("/v1/received", "POST", read(token), recipient.token), 404);
  await noDisclosure(
    await f.request("/v1/received", "POST", { token: nextToken, action: "read" }, recipient.token),
    400,
  );
  expect(await f.db.select().from(openingConsents)).toHaveLength(1);
  expect((await f.request("/v1/received", "POST", read(nextToken), recipient.token)).status).toBe(
    200,
  );
  expect((await f.db.select().from(openingConsents)).map((x) => x.messageRevision).sort()).toEqual([
    1, 2,
  ]);
});
