import { chmod, mkdir } from "node:fs/promises";
const path = ".dev.vars";
if (await Bun.file(path).exists()) {
  console.log(".dev.vars already exists; existing secrets preserved.");
} else {
  const secret = () => crypto.randomUUID() + crypto.randomUUID();
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const content =
    [
      `BETTER_AUTH_SECRET=${secret()}`,
      `ENCRYPTION_KEYS='${JSON.stringify({ local: key })}'`,
      "ENCRYPTION_KEY_ID=local",
      `NOTIFICATION_GATEWAY_SECRET=${secret()}`,
      `WEBHOOK_SECRET=${secret()}`,
      `OPERATIONS_SECRET=${secret()}`,
    ].join("\n") + "\n";
  await Bun.write(path, content);
  await chmod(path, 0o600);
  console.log("Created .dev.vars with local-only random secrets.");
}
await mkdir(".local", { recursive: true, mode: 0o700 });
