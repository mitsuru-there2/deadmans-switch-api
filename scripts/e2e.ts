import { mkdtemp, readFile, rm, cp, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./setup-local";
import { localEnv } from "./local-env";
import { runSuite } from "../tests/e2e/suite";
const local = await localEnv();
const origin = "http://localhost:8791";
const project = await mkdtemp(join(tmpdir(), "deadmans-e2e-"));
const state = join(project, "state");
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = Promise.resolve("");
let errors = Promise.resolve("");
try {
  // Snapshot source and configuration; Void codegen, caches and D1 pointers all stay in this project.
  for (const path of [
    "src",
    "routes",
    "tests",
    "crons",
    "queues",
    "db",
    "env.ts",
    "package.json",
    "void.config.ts",
    "void.lock.json",
    "vite.config.ts",
    "tsconfig.json",
    ".env",
  ])
    await cp(path, join(project, path), { recursive: true });
  await symlink(resolve("node_modules"), join(project, "node_modules"), "dir");
  await mkdir(join(project, ".local"));
  const env = {
    ...process.env,
    APP_ENV: "test",
    GOOGLE_PACKAGE_NAME: "jp.example",
    DMS_TEST_STATE_DIR: state,
    DMS_TEST_CACHE_DIR: join(project, ".vite"),
    BETTER_AUTH_URL: origin,
    RECIPIENT_WEB_URL: origin,
    TRUSTED_ORIGINS: origin,
    DELIVERY_ENABLED: "true",
    WRANGLER_LOG_PATH: join(project, ".local/runtime.log"),
  };
  const running = Bun.spawn(
    ["node", "node_modules/vite/bin/vite.js", "--mode", "e2e", "--port", "8791"],
    { cwd: project, stdout: "pipe", stderr: "pipe", env },
  );
  child = running;
  output = new Response(running.stdout).text();
  errors = new Response(running.stderr).text();
  async function cli(args: string[]) {
    const p = Bun.spawn(["bun", "node_modules/void/dist/cli/cli.mjs", ...args], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const out = await new Response(p.stdout).text(),
      err = await new Response(p.stderr).text();
    if (await p.exited) throw new Error(`Void CLI failed: ${args[1]}\n${out}\n${err}`);
    return out;
  }
  async function assertIsolated() {
    const active = JSON.parse(await readFile(join(project, ".void/local-d1.json"), "utf8"));
    if (active.persistRoot !== state) throw new Error("Refusing to use a non-isolated D1");
  }
  let ready = false;
  for (let n = 0; n < 150; n++) {
    if (child.exitCode !== null) throw new Error("E2E server exited");
    try {
      ready =
        (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok &&
        (
          await fetch(`${origin}/internal/e2e`, {
            headers: { Authorization: `Bearer ${local.OPERATIONS_SECRET}` },
          })
        ).ok;
    } catch {
      /* Startup. */
    }
    if (ready) break;
    await Bun.sleep(200);
  }
  if (!ready) throw new Error("E2E server did not become ready");
  await assertIsolated();
  await cli(["db", "migrate"]);
  await runSuite(origin, local, async (sql) => {
    await assertIsolated();
    return cli(["db", "execute", sql]);
  });
} finally {
  if (child) {
    child.kill();
    await child.exited;
  }
  await Bun.write(".local/e2e-server.log", (await output) + (await errors));
  await rm(project, { recursive: true, force: true });
}
