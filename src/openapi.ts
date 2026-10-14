import { z } from "zod";
import * as c from "./contracts";
import { successResponses } from "./responses";

type Method = "get" | "post" | "put" | "patch" | "delete";
const paths: Record<string, Partial<Record<Method, unknown>>> = {};
function route(
  method: Method,
  path: string,
  summary: string,
  body?: z.ZodType,
  status = 200,
  security: unknown[] = [{ bearerAuth: [] }, { cookieAuth: [] }],
  response?: z.ZodType,
) {
  response ??= successResponses[`${method} ${path}`];
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    security,
    ...(parameters.length ? { parameters } : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: z.toJSONSchema(body, { target: "draft-2020-12", io: "input" }),
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: "Success; see docs/api.md for response details.",
        ...(response
          ? { content: { "application/json": { schema: z.toJSONSchema(response) } } }
          : {}),
      },
      default: {
        description: "Error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  };
}
route("get", "/health/live", "Liveness", undefined, 200, []);
route("get", "/health/ready", "Database readiness", undefined, 200, []);
route(
  "post",
  "/v1/auth/bootstrap",
  "Silently provision a device identity; no paid access yet",
  c.bootstrapSchema,
  201,
  [],
);
route(
  "post",
  "/v1/auth/device-session",
  "Rotate device token or exchange verified email recovery session",
);
route("delete", "/v1/auth/device-sessions", "Revoke all device credentials", undefined, 204);
route(
  "post",
  "/v1/auth/restore",
  "Restore a registered same-store purchase to this device; full purchase proof required",
  c.restorePurchaseSchema,
);
route(
  "post",
  "/v1/contact-email",
  "Verify warning and recovery email; subscription required",
  c.contactEmailSchema,
  202,
);
route(
  "post",
  "/v1/contact-email/confirm",
  "Confirm email link using the original device credential",
  c.confirmContactSchema,
);
route("get", "/v1/billing/account", "Account binding token and configured annual store products");
route(
  "get",
  "/v1/billing/subscriptions",
  "Verified store subscriptions; purchase tokens never returned",
);
route(
  "post",
  "/v1/billing/verify",
  "Verify or restore a store purchase against Apple/Google APIs",
  c.purchaseSchema,
);
route(
  "post",
  "/webhooks/apple",
  "App Store Server Notifications V2; signed JWS certificate chain verified",
  z.object({ signedPayload: z.string() }),
  200,
  [],
);
route(
  "post",
  "/webhooks/google",
  "Google Play RTDN through authenticated Pub/Sub; verify Google OIDC then query purchases API",
  z.object({ message: z.object({ messageId: z.string(), data: z.string() }) }),
  200,
  [{ googleOidc: [] }],
);
route(
  "post",
  "/webhooks/resend",
  "Resend events; raw body signed with Svix headers",
  undefined,
  200,
  [{ svixId: [], svixTimestamp: [], svixSignature: [] }],
);
route(
  "get",
  "/v1/consents/current",
  "Current owner activation consent text and version; available before purchase",
);
route("get", "/v1/me", "Current identity, contact verification and subscription status");
route("delete", "/v1/me", "Delete account and private data", c.deleteAccountSchema, 204);
route("get", "/v1/switch", "Switch state, version, deadlines and entitlement");
route("patch", "/v1/switch", "Update paused switch settings", c.settingsSchema);
route("post", "/v1/switch/activate", "Explicitly activate or resume", c.activationSchema);
route("post", "/v1/switch/pause", "Pause and revoke pending releases");
route(
  "post",
  "/v1/check-ins",
  "Record foreground or explicit notification action",
  c.checkInSchema,
);
route("get", "/v1/recipients", "List own recipients");
route("post", "/v1/recipients", "Create an unconfirmed recipient", c.contactSchema, 201);
route("delete", "/v1/recipients/{id}", "Delete recipient and message", c.versionSchema);
route(
  "post",
  "/v1/recipients/{id}/invite",
  "Send recipient consent invitation by email",
  undefined,
  202,
);
route("get", "/v1/messages", "List decrypted own messages");
route(
  "put",
  "/v1/recipients/{id}/message",
  "Create or revise a recipient message",
  c.messageSchema,
);
route("delete", "/v1/recipients/{id}/message", "Delete recipient message", c.versionSchema);
route(
  "post",
  "/v1/invitations/preview",
  "Inspect an invitation matching the signed-in email",
  c.previewSchema,
);
route(
  "post",
  "/v1/invitations/respond",
  "Accept, decline or report an invitation",
  c.invitationSchema,
);
route(
  "post",
  "/v1/recipient-consents/{id}/withdraw",
  "Withdraw or report recipient consent",
  c.withdrawalSchema,
);
route(
  "post",
  "/v1/received",
  "Preview notice; explicitly confirm death and open, refuse or report a live release",
  c.receivedSchema,
  200,
  [{ bearerAuth: [] }, { cookieAuth: [] }],
  c.receivedResponseSchema,
);
route("post", "/v1/devices", "Register an Expo push token", c.deviceSchema, 201);
route("delete", "/v1/devices/{id}", "Remove a device", undefined, 204);
route("post", "/v1/self-test", "Send a fixed test notice only to self", undefined, 202);
route("get", "/v1/deliveries", "Recent delivery ledger");
route("get", "/v1/audit", "Recent audit events");
route("get", "/v1/export", "Export own plaintext content as JSON attachment");
for (const [method, path, summary] of [
  ["post", "probe", "Record successful external API probe"],
  ["post", "tick", "Run scheduler and dispatch once"],
  ["post", "recover", "Clear operational incident; owners remain held"],
  ["get", "status", "Operational health and pending/uncertain jobs"],
] as const)
  route(method, `/internal/${path}`, summary, undefined, 200, [{ operationsAuth: [] }]);
route(
  "post",
  "/webhooks/events",
  "Trusted billing / notification integration; HMAC-SHA256(timestamp.rawBody), timestamp in milliseconds, ±5 min",
  c.webhookSchema,
  200,
  [{ webhookSignature: [], webhookTimestamp: [] }],
);
route(
  "post",
  "/api/auth/sign-in/magic-link",
  "Request recipient authentication or owner recovery email",
  z.object({ email: z.email(), callbackURL: z.string().optional(), name: z.string().optional() }),
  200,
  [],
);
paths["/api/auth/magic-link/verify"] = {
  get: {
    summary: "Consume single-use magic link and establish session",
    security: [],
    parameters: [
      { name: "token", in: "query", required: true, schema: { type: "string" } },
      { name: "callbackURL", in: "query", schema: { type: "string" } },
    ],
    responses: {
      "200": { description: "Session without redirect" },
      "302": { description: "Callback redirect with session cookie and set-auth-token header" },
    },
  },
};
route("post", "/api/auth/sign-out", "End current session");
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "私に何かあったら API",
    version: "0.1.0",
    description:
      "All application timestamps are Unix milliseconds in UTC. Japan-only production access. Owners use automatically provisioned device credentials and verified store subscriptions (including trials). Main owner APIs return 403 SUBSCRIPTION_REQUIRED without an entitlement. Better Auth magic links are for recipients and owner recovery. An inactivity switch does not establish death.",
  },
  servers: [{ url: "/" }],
  paths,
  components: {
    securitySchemes: {
      googleOidc: {
        type: "http",
        scheme: "bearer",
        description:
          "Google-signed OIDC JWT with configured audience and push service account email",
      },
      svixId: { type: "apiKey", in: "header", name: "svix-id" },
      svixTimestamp: { type: "apiKey", in: "header", name: "svix-timestamp" },
      svixSignature: { type: "apiKey", in: "header", name: "svix-signature" },
      bearerAuth: { type: "http", scheme: "bearer" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token" },
      operationsAuth: {
        type: "http",
        scheme: "bearer",
        description: "Separate OPERATIONS_SECRET; never distribute to clients",
      },
      webhookSignature: { type: "apiKey", in: "header", name: "X-Signature" },
      webhookTimestamp: { type: "apiKey", in: "header", name: "X-Timestamp" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
        },
      },
    },
  },
};
