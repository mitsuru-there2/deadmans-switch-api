import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, magicLink } from "better-auth/plugins";
import type { Database } from "./db/client";
import * as schema from "./db/schema";
import type { Env } from "./config";
import { Vault } from "./lib/crypto";
import { enqueue } from "./services/notifications";
import { and, eq, gt } from "drizzle-orm";
import { hash, randomToken } from "./lib/crypto";

export function createAuth(db: Database, env: Env) {
  return betterAuth({
    appName: "私に何かあったら",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema, transaction: false }),
    trustedOrigins: env.TRUSTED_ORIGINS.split(",").map((v) => v.trim()),
    emailAndPassword: { enabled: false },
    session: {
      additionalFields: {
        authGeneration: { type: "number", defaultValue: 0, input: false, returned: false },
      },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    logger: { disabled: true },
    databaseHooks: {
      session: {
        create: {
          before: async (data, ctx) => {
            // A proof checked before an email change must never mint a current-generation session.
            if (ctx?.path !== "/magic-link/verify") return false;
            const token = ctx.query?.token;
            if (typeof token !== "string") return false;
            const binding = (
              await db
                .select()
                .from(schema.authLinkBindings)
                .where(
                  and(
                    eq(schema.authLinkBindings.tokenHash, await hash(token)),
                    gt(schema.authLinkBindings.expiresAt, Date.now()),
                  ),
                )
            )[0];
            const owner = (
              await db.select().from(schema.user).where(eq(schema.user.id, data.userId))
            )[0];
            if (
              !binding ||
              !owner ||
              owner.email !== binding.email ||
              owner.authGeneration !== binding.generation ||
              (binding.userId
                ? binding.userId !== owner.id
                : owner.createdAt.getTime() < binding.createdAt)
            )
              return false;
            return { data: { ...data, authGeneration: binding.generation } };
          },
        },
      },
    },
    plugins: [
      bearer(),
      magicLink({
        generateToken: async (email) => {
          const token = randomToken(),
            now = Date.now();
          const owner = (
            await db.select().from(schema.user).where(eq(schema.user.email, email.toLowerCase()))
          )[0];
          await db.insert(schema.authLinkBindings).values({
            tokenHash: await hash(token),
            email: email.toLowerCase(),
            userId: owner?.id ?? null,
            generation: owner?.authGeneration ?? 0,
            createdAt: now,
            expiresAt: now + 600_000,
          });
          return token;
        },
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

export async function validSession(auth: Auth, db: Database, headers: Headers) {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  const row = (
    await db
      .select({ generation: schema.session.authGeneration, current: schema.user.authGeneration })
      .from(schema.session)
      .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
      .where(eq(schema.session.id, result.session.id))
  )[0];
  return row && row.generation === row.current ? result : null;
}
