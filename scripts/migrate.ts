import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
const url = process.env.TURSO_DATABASE_URL ?? "http://127.0.0.1:8080";
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  await client.execute("PRAGMA foreign_keys = ON");
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  console.log("Database migrations applied.");
} finally {
  client.close();
}
