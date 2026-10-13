import { sign } from "../src/lib/crypto";
import { localEnv } from "./local-env";
const env = await localEnv();
const [command, userId] = process.argv.slice(2);
const base = "http://localhost:8787";
if (command === "grant") {
  if (!userId) throw new Error("Usage: bun scripts/local-control.ts grant USER_ID");
  const timestamp = String(Date.now());
  const body = JSON.stringify({
    id: crypto.randomUUID(),
    type: "entitlement",
    userId,
    plan: "basic",
    status: "active",
    validUntil: Date.now() + 365 * 86_400_000,
    sourceVersion: Date.now(),
  });
  const response = await fetch(`${base}/webhooks/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-Signature": await sign(env.WEBHOOK_SECRET!, `${timestamp}.${body}`),
    },
    body,
  });
  console.log(response.status, await response.text());
} else if (["probe", "tick", "recover", "status"].includes(command ?? "")) {
  const response = await fetch(`${base}/internal/${command}`, {
    method: command === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${env.OPERATIONS_SECRET}` },
  });
  console.log(response.status, await response.text());
} else
  throw new Error("Usage: bun scripts/local-control.ts probe|tick|recover|status|grant [USER_ID]");
