import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup-local";
import { localEnv } from "./local-env";
const local = await localEnv();
const origin = "http://localhost:8790";
const state = await mkdtemp(join(tmpdir(), "deadmans-void-"));
const previousState = await readFile(".void/local-d1.json").catch(() => null);
const child = Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", "8790"], {
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    DMS_TEST_STATE_DIR: state,
    BETTER_AUTH_URL: origin,
    RECIPIENT_WEB_URL: origin,
    TRUSTED_ORIGINS: origin,
    WRANGLER_LOG_PATH: ".local/runtime-test.log",
  },
});
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
try {
  let result:
    | { reactEmail: boolean; appleRejected: boolean; appleRestoreRejected: boolean }
    | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Void runtime exited before becoming ready");
    try {
      const response = await fetch(`${origin}/internal/runtime-test`, {
        headers: { Authorization: `Bearer ${local.OPERATIONS_SECRET}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        result = (await response.json()) as typeof result;
        break;
      }
    } catch {
      /* Workerd may still be starting. */
    }
    await Bun.sleep(200);
  }
  if (!result?.reactEmail || !result.appleRejected || !result.appleRestoreRejected)
    throw new Error("Void workerd compatibility check failed");
  const activeState = JSON.parse(await readFile(".void/local-d1.json", "utf8"));
  if (activeState.persistRoot !== state) throw new Error("Void test database is not isolated");
  const migrate = Bun.spawn(["bun", "run", "db:migrate"], { stdout: "inherit", stderr: "inherit" });
  if ((await migrate.exited) !== 0) throw new Error("Void test database migration failed");
  const smoke = Bun.spawn(["bun", "scripts/smoke.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, API_BASE_URL: origin },
  });
  if ((await smoke.exited) !== 0) throw new Error("Void end-to-end API check failed");
  console.log(
    "Void workerd: React Email, D1, device/email recovery and Apple forged-JWS rejection passed.",
  );
} finally {
  child.kill();
  await child.exited;
  if (previousState) await writeFile(".void/local-d1.json", previousState);
  else await rm(".void/local-d1.json", { force: true });
  await rm(state, { recursive: true, force: true });
  const output = (await stdout) + (await stderr);
  await Bun.write(".local/void-test-server.log", output);
  if (child.exitCode !== 0 && output.includes("Uncaught"))
    console.error(output.replaceAll(/token=[^\s"<]+/g, "token=[redacted]"));
}
