import { z } from "zod";

const config = z.object({
  APP_ENV: z.enum(["development", "test", "production"]),
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().optional(),
  TURSO_LOCATION: z.enum(["local", "nrt"]),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  TRUSTED_ORIGINS: z.string().min(1),
  RECIPIENT_WEB_URL: z.url(),
  // JSON map of key IDs to base64 encoded 32-byte keys. Keep old keys during rotation.
  ENCRYPTION_KEYS: z.string().min(1),
  ENCRYPTION_KEY_ID: z.string().min(1),
  NOTIFICATION_GATEWAY_URL: z.url().optional(),
  NOTIFICATION_GATEWAY_SECRET: z.string().min(32).optional(),
  WEBHOOK_SECRET: z.string().min(32),
  OPERATIONS_SECRET: z.string().min(32),
  NOTIFICATION_DRIVER: z.enum(["gateway", "native"]).optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  STORE_PRODUCTS: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  APPLE_APP_ID: z.string().regex(/^\d+$/).optional(),
  APPLE_ENVIRONMENT: z.enum(["Production", "Sandbox"]).optional(),
  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  APPLE_ROOT_CERTIFICATES: z.string().optional(),
  GOOGLE_PACKAGE_NAME: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  GOOGLE_PUBSUB_EMAIL: z.string().optional(),
  DELIVERY_ENABLED: z.enum(["true", "false"]).default("false"),
});
export type Env = z.infer<typeof config>;
export function parseEnv(input: unknown): Env {
  const env = config.parse(input);
  if (env.APP_ENV === "production") {
    if (env.APPLE_ENVIRONMENT === "Sandbox")
      throw new Error("Sandbox purchases are not allowed in production");
    if (env.NOTIFICATION_DRIVER === "native" && (!env.RESEND_API_KEY || !env.EMAIL_FROM))
      throw new Error("Resend configuration required");
    if (env.TURSO_LOCATION !== "nrt" || !env.TURSO_AUTH_TOKEN)
      throw new Error("Tokyo database required");
    for (const url of [
      env.BETTER_AUTH_URL,
      env.RECIPIENT_WEB_URL,
      ...(env.NOTIFICATION_GATEWAY_URL ? [env.NOTIFICATION_GATEWAY_URL] : []),
    ]) {
      if (!url.startsWith("https://")) throw new Error("HTTPS required");
    }
    if (!/^(libsql|https):\/\//.test(env.TURSO_DATABASE_URL))
      throw new Error("Remote Turso required");
    for (const origin of env.TRUSTED_ORIGINS.split(",")) {
      if (!origin.startsWith("https://")) throw new Error("HTTPS origin required");
    }
  }
  return env;
}
