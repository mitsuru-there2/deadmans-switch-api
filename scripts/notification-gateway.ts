import { mkdir, chmod } from "node:fs/promises";
import { z } from "zod";
import { localEnv } from "./local-env";
import { secretEqual } from "../src/lib/crypto";
const env = await localEnv();
await mkdir(".local/mailbox", { recursive: true, mode: 0o700 });
const schema = z
  .object({
    id: z.uuid(),
    channel: z.enum(["email", "push"]),
    to: z.string(),
    template: z.enum([
      "magic_link",
      "contact_verification",
      "invitation",
      "reminder",
      "warning",
      "final",
      "self_test",
    ]),
    url: z.url().optional(),
    scheduledAt: z.number().optional(),
    expiresAt: z.number().optional(),
    senderName: z.string().max(100).optional(),
  })
  .strict();
Bun.serve({
  hostname: "127.0.0.1",
  port: 8788,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/notifications")
      return new Response(null, { status: 404 });
    if (
      !(await secretEqual(
        request.headers.get("Authorization") ?? "",
        `Bearer ${env.NOTIFICATION_GATEWAY_SECRET}`,
      ))
    ) {
      console.warn("Local gateway: authentication rejected");
      return new Response(null, { status: 401 });
    }
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success || request.headers.get("Idempotency-Key") !== parsed.data.id) {
      console.warn(
        "Local gateway: request rejected",
        parsed.success
          ? "idempotency key"
          : parsed.error.issues.map((issue) => issue.path.join(".")),
      );
      return new Response(null, { status: 400 });
    }
    const notice = parsed.data;
    const file = `.local/mailbox/${notice.id}.json`;
    if (!(await Bun.file(file).exists())) {
      await Bun.write(file, JSON.stringify(notice, null, 2));
      await chmod(file, 0o600);
    }
    // This server never delivers externally. Inspect local files to open test links.
    console.log(`Captured ${notice.template}: ${notice.id}`);
    return Response.json({ state: "accepted", providerId: `local:${notice.id}` });
  },
});
console.log("Local notification capture running at http://127.0.0.1:8788");
