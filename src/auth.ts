import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, magicLink } from "better-auth/plugins";
import type { Database } from "./db/client";
import * as schema from "./db/schema";
import type { Env } from "./env";
import { Vault } from "./lib/crypto";
import { enqueue } from "./services/notifications";

export function createAuth(db: Database, env: Env) {
  return betterAuth({
    appName: "私に何かあったら",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema, transaction: true }),
    trustedOrigins: env.TRUSTED_ORIGINS.split(",").map((v) => v.trim()),
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    logger: { disabled: true },
    plugins: [
      bearer(),
      magicLink({
        expiresIn: 600,
        storeToken: "hashed",
        rateLimit: { window: 60, max: 5 },
        sendMagicLink: async ({ email, url }) => {
          const now = Date.now();
          await enqueue(
            db,
            new Vault(env),
            "auth",
            `auth:${crypto.randomUUID()}`,
            { channel: "email", to: email, template: "magic_link", url, expiresAt: now + 600_000 },
            now,
          );
        },
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
