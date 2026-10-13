import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import type { Env } from "../env";
import * as schema from "./schema";
export function connectDb(env: Env) {
  const client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  return { client, db: drizzle(client, { schema }) };
}
export type Database = ReturnType<typeof connectDb>["db"];
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;
