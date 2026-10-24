import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
test("migrations initialize a fresh database with defaults and credential deletion semantics", () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8"));
    const entries = journal.entries as Array<{ tag: string }>;
    for (const entry of entries) db.exec(readFileSync(`db/migrations/${entry.tag}.sql`, "utf8"));
    expect(db.query("SELECT id, revision FROM _d1_revision").get()).toEqual({ id: 1, revision: 0 });
    db.exec(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.jp', 1, 1, 1)",
    );
    db.exec(
      "INSERT INTO profiles (id,user_id,created_at,updated_at) VALUES ('profile','owner',1,1)",
    );
    db.exec(
      "INSERT INTO devices (id, profile_id, token, token_hash, created_at) VALUES ('phone','profile','encrypted','hash',1)",
    );
    expect(db.query("SELECT email, auth_generation FROM user").get()).toEqual({
      email: "owner@example.jp",
      auth_generation: 0,
    });
    expect(db.query("SELECT id,name,platform,credential_id FROM devices").get()).toEqual({
      id: "phone",
      name: null,
      platform: null,
      credential_id: null,
    });
    db.exec(
      "INSERT INTO device_credentials(id,user_id,token_hash,expires_at,created_at) VALUES ('credential','owner','native',999,1)",
    );
    db.exec("UPDATE devices SET credential_id='credential'");
    db.exec("DELETE FROM device_credentials");
    expect(db.query("SELECT credential_id FROM devices").get()).toEqual({ credential_id: null });
  } finally {
    db.close();
  }
});
