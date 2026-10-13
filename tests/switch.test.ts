import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  deliveries,
  entitlements,
  messages,
  outbox,
  releases,
  systemHealth,
} from "../src/db/schema";
import { dispatch, type Notice, recordResult } from "../src/services/notifications";
import { probe, tick } from "../src/services/scheduler";
import { CONSENT_VERSION, DAY } from "../src/services/switch";
import { fixture, type Fixture } from "./helpers";
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => {
  f.client.close();
});
async function grace() {
  const result = await f.ready();
  f.advance(30 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  return result;
}
async function release() {
  const result = await grace();
  await f.flush();
  f.advance(7 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  return result;
}
describe("dead man's switch invariants", () => {
  test("encrypted at rest and isolated by recipient context", async () => {
    const { recipientId } = await f.ready();
    const m = (await f.db.select().from(messages))[0]!;
    expect(m.ciphertext).not.toContain("家族への");
    expect(await f.service.vault.open(m.ciphertext, `message:${recipientId}`)).toEqual({
      title: "大切な伝言",
      body: "家族への機密メッセージ",
    });
    await expect(f.service.vault.open(m.ciphertext, "message:another-recipient")).rejects.toThrow();
  });
  test("warning acceptance starts a full grace period, never the missed deadline", async () => {
    const { owner } = await grace();
    expect((await f.service.status(owner.id)).state).toBe("grace");
    f.advance(10 * DAY);
    await f.healthy();
    await tick(f.db, f.env, f.now());
    expect((await f.db.select().from(releases)).length).toBe(0);
    await f.flush();
    f.advance(7 * DAY - 1);
    await f.healthy();
    await tick(f.db, f.env, f.now());
    expect((await f.db.select().from(releases)).length).toBe(0);
    f.advance(1);
    await f.healthy();
    await tick(f.db, f.env, f.now());
    expect((await f.db.select().from(releases)).length).toBe(1);
  });
  test("foreground check-in during grace invalidates warnings and pending release", async () => {
    const { owner } = await grace();
    const before = await f.service.status(owner.id);
    await f.service.checkIn(owner.id, "foreground");
    await f.flush();
    expect(f.captured.filter((x) => x.notice.template === "warning").length).toBe(0);
    const after = await f.service.status(owner.id);
    expect(after.version).toBe(before.version + 1);
    expect(after.lastCheckInAt).toBe(f.now());
    expect(after.state).toBe("active");
  });
  test("pause after release preparation cancels queued sends and revokes links", async () => {
    const { owner } = await release();
    const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
    const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
    await f.service.pause(owner.id);
    await f.flush();
    expect(f.captured.filter((x) => x.notice.template === "final").length).toBe(0);
    await expect(
      f.service.readDelivery("family@example.jp", notice.url!.split("#")[1]!, "read"),
    ).rejects.toThrow("NOT_FOUND");
  });
  test("duplicate cron/dispatch produce one snapshot and one final send", async () => {
    await release();
    await tick(f.db, f.env, f.now());
    await f.flush();
    await f.flush();
    expect((await f.db.select().from(releases)).length).toBe(1);
    expect((await f.db.select().from(deliveries)).length).toBe(1);
    expect(f.captured.filter((x) => x.notice.template === "final").length).toBe(1);
    expect(JSON.stringify(f.captured)).not.toContain("家族への機密メッセージ");
  });
  test("timeout is uncertain and never blindly resent", async () => {
    await release();
    let calls = 0;
    const transport = async () => {
      calls++;
      throw new Error("timeout");
    };
    await dispatch(f.db, f.env, f.service.vault, transport, f.now());
    await dispatch(f.db, f.env, f.service.vault, transport, f.now());
    expect(calls).toBe(1);
    const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
    expect(job.state).toBe("uncertain");
    await recordResult(f.db, job.id, { state: "accepted", providerId: "reconciled" }, f.now());
    expect((await f.db.select().from(outbox).where(eq(outbox.id, job.id)))[0]!.state).toBe(
      "accepted",
    );
  });
  test("scheduler outage holds instead of catching up overdue releases", async () => {
    const { owner } = await f.ready();
    f.advance(40 * DAY);
    await tick(f.db, f.env, f.now());
    expect((await f.service.status(owner.id)).state).toBe("held");
    await f.healthy();
    await tick(f.db, f.env, f.now());
    expect((await f.service.status(owner.id)).state).toBe("held");
    expect((await f.db.select().from(releases)).length).toBe(0);
  });
  test("probe records API outage even when it resumes before cron", async () => {
    const { owner } = await f.ready();
    f.advance(360_000);
    await f.db
      .update(systemHealth)
      .set({ lastTickAt: f.now() })
      .where(eq(systemHealth.id, "scheduler"));
    await probe(f.db, f.now());
    await tick(f.db, f.env, f.now());
    expect((await f.service.status(owner.id)).state).toBe("held");
  });
  test("expired subscription blocks release and does not auto-resume on renewal", async () => {
    const { owner } = await grace();
    await f.flush();
    await f.db
      .update(entitlements)
      .set({ validUntil: f.now() })
      .where(eq(entitlements.profileId, owner.profile.id));
    await tick(f.db, f.env, f.now());
    expect((await f.service.status(owner.id)).holdReason).toBe("entitlement_inactive");
    await f.db
      .update(entitlements)
      .set({ validUntil: f.now() + 365 * DAY })
      .where(eq(entitlements.profileId, owner.profile.id));
    await tick(f.db, f.env, f.now());
    expect((await f.service.status(owner.id)).state).toBe("held");
  });
  test("kill switch holds active profiles and activation is denied", async () => {
    const { owner } = await f.ready();
    f.env.DELIVERY_ENABLED = "false";
    await tick(f.db, f.env, f.now());
    const p = await f.service.status(owner.id);
    expect(p.state).toBe("held");
    await expect(f.service.activate(owner.id, p.version, CONSENT_VERSION)).rejects.toThrow(
      "DELIVERY_DISABLED",
    );
  });
  test("only the verified recipient email plus live token can view", async () => {
    await release();
    const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
    const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
    const token = notice.url!.split("#")[1]!;
    await expect(f.service.readDelivery("attacker@example.jp", token, "read")).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(await f.service.readDelivery("family@example.jp", token, "read")).toMatchObject({
      message: { body: "家族への機密メッセージ" },
    });
    await f.service.readDelivery("family@example.jp", token, "decline");
    await expect(f.service.readDelivery("family@example.jp", token, "read")).rejects.toThrow(
      "NOT_FOUND",
    );
  });
  test("active content cannot be edited; stale version cannot overwrite draft", async () => {
    const { owner, recipientId } = await f.ready();
    let p = await f.service.status(owner.id);
    await expect(
      f.service.writeMessage(owner.id, recipientId, {
        version: p.version,
        title: "changed",
        body: "changed",
      }),
    ).rejects.toThrow("PAUSE_BEFORE_EDITING");
    await f.service.pause(owner.id);
    await expect(
      f.service.writeMessage(owner.id, recipientId, {
        version: p.version,
        title: "changed",
        body: "changed",
      }),
    ).rejects.toThrow("VERSION_CONFLICT");
    p = await f.service.status(owner.id);
    await f.service.writeMessage(owner.id, recipientId, {
      version: p.version,
      title: "changed",
      body: "changed",
    });
  });
  test("stale warning acknowledgement cannot revive cancelled generation", async () => {
    const { owner } = await grace();
    const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "warning")))[0]!;
    await f.db.update(outbox).set({ state: "sending" }).where(eq(outbox.id, job.id));
    await f.service.checkIn(owner.id, "notification_action");
    await recordResult(f.db, job.id, { state: "accepted", providerId: "old" }, f.now());
    expect((await f.service.status(owner.id)).warningAcceptedAt).toBeNull();
  });
  test("dispatch rechecks entitlement after preparation", async () => {
    const { owner } = await release();
    await f.db
      .update(entitlements)
      .set({ status: "revoked" })
      .where(eq(entitlements.profileId, owner.profile.id));
    await f.flush();
    expect(f.captured.some((x) => x.notice.template === "final")).toBe(false);
  });
});

test("pause racing an external send revokes viewing even when provider accepts", async () => {
  const { owner } = await release();
  let sentToken = "";
  await dispatch(
    f.db,
    f.env,
    f.service.vault,
    async (id, notice) => {
      sentToken = notice.url!.split("#")[1]!;
      await f.service.pause(owner.id);
      return { state: "accepted", providerId: id };
    },
    f.now(),
  );
  expect(sentToken.length).toBeGreaterThan(30);
  await expect(f.service.readDelivery("family@example.jp", sentToken, "read")).rejects.toThrow(
    "NOT_FOUND",
  );
  expect((await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!.state).toBe(
    "accepted",
  );
});
test("worker crash after claiming never causes an automatic duplicate", async () => {
  await release();
  const final = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
  await f.db
    .update(outbox)
    .set({ state: "sending", claimedAt: f.now() - 121_000 })
    .where(eq(outbox.id, final.id));
  await f.flush();
  expect(f.captured.some((v) => v.notice.template === "final")).toBe(false);
  expect((await f.db.select().from(outbox).where(eq(outbox.id, final.id)))[0]!.state).toBe(
    "uncertain",
  );
});
test("late warning bounce cancels a prepared release", async () => {
  const { owner } = await release();
  const warning = (await f.db.select().from(outbox).where(eq(outbox.kind, "warning")))[0]!;
  await f.db.transaction((tx) => recordResult(tx, warning.id, { state: "failed" }, f.now()));
  await f.flush();
  expect((await f.service.status(owner.id)).state).toBe("held");
  expect(f.captured.some((v) => v.notice.template === "final")).toBe(false);
});
test("recipient can withdraw consent before any final delivery", async () => {
  const { owner, recipientId } = await f.ready();
  await expect(
    f.service.withdrawConsent("other@example.jp", recipientId, "decline"),
  ).rejects.toThrow("NOT_FOUND");
  await f.service.withdrawConsent("family@example.jp", recipientId, "decline");
  expect((await f.service.status(owner.id)).state).toBe("held");
});
test("basic plan caps registered recipients at ten", async () => {
  const owner = await f.createUser();
  let version = 1;
  for (let i = 0; i < 10; i++) {
    version = (
      await f.service.addRecipient(owner.id, {
        version,
        name: String(i),
        email: `r${i}@example.jp`,
        channel: "email",
      })
    ).version;
  }
  await expect(
    f.service.addRecipient(owner.id, {
      version,
      name: "overflow",
      email: "r11@example.jp",
      channel: "email",
    }),
  ).rejects.toThrow("RECIPIENT_LIMIT");
});
test("links expire after thirty days", async () => {
  await release();
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  f.advance(30 * DAY);
  await expect(
    f.service.readDelivery("family@example.jp", notice.url!.split("#")[1]!, "read"),
  ).rejects.toThrow("NOT_FOUND");
});

test("deleting a device cancels an already queued push without deleting the ledger", async () => {
  const { owner } = await f.ready();
  const device = await f.service.addDevice(owner.id, "ExpoPushToken[local-test]");
  f.advance(DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  const queued = (await f.db.select().from(outbox).where(eq(outbox.kind, "reminder")))[0]!;
  expect(queued.deviceId).toBe(device.id);
  expect(
    (await f.request(`/v1/devices/${device.id}`, "DELETE", undefined, owner.token)).status,
  ).toBe(204);
  await f.flush();
  expect(f.captured.some((v) => v.notice.template === "reminder")).toBe(false);
  expect((await f.db.select().from(outbox).where(eq(outbox.id, queued.id)))[0]!.state).toBe(
    "cancelled",
  );
});
test("concurrent dispatchers cannot both claim a final notice", async () => {
  await release();
  await Promise.allSettled([f.flush(), f.flush()]);
  await f.flush();
  expect(f.captured.filter((v) => v.notice.template === "final").length).toBe(1);
});
test("concurrent release preparation produces at most one release per version", async () => {
  await grace();
  await f.flush();
  f.advance(7 * DAY);
  await f.healthy();
  await Promise.allSettled([tick(f.db, f.env, f.now()), tick(f.db, f.env, f.now())]);
  await tick(f.db, f.env, f.now());
  expect((await f.db.select().from(releases)).length).toBe(1);
  expect((await f.db.select().from(deliveries)).length).toBe(1);
});
