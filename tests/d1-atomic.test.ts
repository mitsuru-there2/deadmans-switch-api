import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, getTableName, is, Table } from "drizzle-orm";
import { atomic } from "../src/db/client";
import * as schema from "../src/db/schema";
import { fixture, type Fixture } from "./helpers";
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => f.client.close());

test("a failed plan and a failed D1 batch both leave all prior writes rolled back", async () => {
  const owner = await f.createUser();
  const before = f.client.query("SELECT revision FROM _d1_revision").get();
  await expect(
    atomic(f.db, async (tx) => {
      await tx
        .update(schema.profiles)
        .set({ state: "paused" })
        .where(eq(schema.profiles.id, owner.profile.id));
      throw new Error("abort plan");
    }),
  ).rejects.toThrow("abort plan");
  await expect(
    atomic(f.db, async (tx) => {
      await tx
        .update(schema.profiles)
        .set({ state: "paused" })
        .where(eq(schema.profiles.id, owner.profile.id));
      await tx.insert(schema.user).values({
        id: owner.id,
        name: "duplicate",
        email: "duplicate@example.jp",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }),
  ).rejects.toThrow();
  expect((await f.db.select().from(schema.profiles))[0]!.state).toBe("draft");
  expect(f.client.query("SELECT revision FROM _d1_revision").get()).toEqual(before);
});

test("a concurrent write outside atomic invalidates the plan before its D1 commit", async () => {
  const owner = await f.createUser();
  let read!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    read = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let attempts = 0;
  const update = atomic(f.db, async (tx) => {
    const p = (
      await tx.select().from(schema.profiles).where(eq(schema.profiles.id, owner.profile.id))
    )[0]!;
    if (++attempts === 1) {
      read();
      await gate;
    }
    await tx
      .update(schema.profiles)
      .set({ version: p.version + 1 })
      .where(eq(schema.profiles.id, p.id));
    return p.state;
  });
  await ready;
  await f.db
    .update(schema.profiles)
    .set({ state: "paused" })
    .where(eq(schema.profiles.id, owner.profile.id));
  resume();
  expect(await update).toBe("paused");
  expect(attempts).toBe(2);
});

test("simultaneous settings updates cannot both accept the same version", async () => {
  const owner = await f.createUser();
  const results = await Promise.allSettled(
    [30, 40].map((inactivityDays) =>
      f.service.changeSettings(owner.id, { version: 1, inactivityDays, graceDays: 7 }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await f.service.status(owner.id)).version).toBe(2);
});

test("every application table has all three D1 revision triggers", () => {
  const triggers = f.client
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;
    const table = getTableName(value);
    if (table === "_d1_revision") continue;
    for (const operation of ["insert", "update", "delete"])
      expect(triggers.some((t) => t.name === `_d1_revision_${table}_${operation}`)).toBe(true);
  }
});
