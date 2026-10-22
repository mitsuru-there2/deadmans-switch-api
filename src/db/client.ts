import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Env } from "../config";
import { AppError } from "../lib/errors";
import * as schema from "./schema";

export function connectDb(env: Pick<Env, "DB">) {
  return { db: drizzle(env.DB, { schema }) };
}
export type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };
export type Tx = Database;
export type DbOrTx = Database;

const revisionSql = "SELECT revision FROM _d1_revision WHERE id = 1";
async function revision(binding: D1Database) {
  const row = await binding.prepare(revisionSql).first<{ revision: number }>();
  if (!row) throw new Error("D1 migrations required");
  return row.revision;
}

/**
 * Plan against committed rows, then atomically validate the read revision and apply
 * all writes in D1.batch(). Triggers bump the revision for EVERY application write,
 * including writes outside this helper. A conflicting plan is discarded and rebuilt.
 * Callbacks must have no external effects, use planned values for read-after-write,
 * and never use mutation RETURNING (there is no uncommitted D1 connection).
 */
export async function atomic<T>(db: Database, plan: (tx: Tx) => Promise<T>): Promise<T> {
  const binding = db.$client;
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await revision(binding);
    const writes: D1PreparedStatement[] = [];
    const planningBinding = {
      prepare(query: string) {
        function statement(params: unknown[] = []): D1PreparedStatement {
          const prepared = binding.prepare(query).bind(...params);
          const isRead = /^\s*select\b/i.test(query);
          return new Proxy(prepared, {
            get(target, name) {
              if (name === "bind") return (...values: unknown[]) => statement(values);
              if (["all", "raw", "first", "run"].includes(String(name))) {
                return (...args: unknown[]) => {
                  if (isRead) {
                    const method = Reflect.get(target, name) as (...args: unknown[]) => unknown;
                    return method.apply(target, args);
                  }
                  if (name !== "run" || !/^\s*(insert|update|delete)\b/i.test(query))
                    throw new Error("D1 plans require mutations without RETURNING");
                  writes.push(prepared);
                  return Promise.resolve({ success: true, results: [], meta: {} });
                };
              }
              return Reflect.get(target, name);
            },
          });
        }
        return statement();
      },
    } as D1Database;
    let result: T;
    try {
      result = await plan(drizzle(planningBinding, { schema }));
    } catch (error) {
      if ((await revision(binding)) !== before) continue;
      throw error;
    }
    try {
      await binding.batch([
        binding
          .prepare(
            "UPDATE _d1_revision SET revision = CASE WHEN revision = ? THEN revision ELSE NULL END WHERE id = 1",
          )
          .bind(before),
        ...writes,
      ]);
      return result;
    } catch (error) {
      let cause: unknown = error;
      let conflict = false;
      while (cause instanceof Error) {
        conflict ||= cause.message.includes("_d1_revision.revision");
        cause = cause.cause;
      }
      if (!conflict) throw error;
    }
  }
  throw new AppError(503, "DATABASE_BUSY");
}
