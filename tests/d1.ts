import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";

// D1's async statement/batch API backed by SQLite for fast service tests.
// Production-runtime tests also exercise the real D1 binding through Void.
export function testD1() {
  const client = new SQLite(":memory:");
  client.exec("PRAGMA foreign_keys = ON");
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8"));
  for (const entry of journal.entries) {
    client.exec(readFileSync(`db/migrations/${entry.tag}.sql`, "utf8"));
  }
  class Statement {
    constructor(
      private sql: string,
      private params: SQLQueryBindings[] = [],
    ) {}
    bind(...params: SQLQueryBindings[]) {
      return new Statement(this.sql, params);
    }
    execute() {
      if (/^\s*(begin|commit|rollback|savepoint)/i.test(this.sql))
        throw new Error("D1 does not support interactive transactions");
      const results = client.query(this.sql).all(...this.params);
      const info = client
        .query("SELECT changes() AS changes, last_insert_rowid() AS last_row_id")
        .get() as { changes: number; last_row_id: number };
      return {
        success: true,
        results,
        meta: { ...info, duration: 0, rows_read: results.length, rows_written: info.changes },
      };
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
    async raw() {
      return client.query(this.sql).values(...this.params);
    }
    async first(column?: string) {
      const row = client.query(this.sql).get(...this.params) as Record<string, unknown> | null;
      return column ? (row?.[column] ?? null) : row;
    }
  }
  const binding = {
    prepare(sql: string) {
      return new Statement(sql);
    },
    async batch(statements: Statement[]) {
      return client.transaction(() => statements.map((stmt) => stmt.execute())).immediate();
    },
  } as unknown as D1Database;
  return { client, binding };
}
