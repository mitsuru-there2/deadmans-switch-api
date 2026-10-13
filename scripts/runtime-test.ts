const child = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--config",
    "wrangler.test.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    "8790",
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WRANGLER_LOG_PATH: ".local/runtime-test.log" },
  },
);
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
try {
  let result:
    | { reactEmail: boolean; appleRejected: boolean; appleRestoreRejected: boolean }
    | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Runtime exited before becoming ready");
    try {
      const response = await fetch("http://127.0.0.1:8790", { signal: AbortSignal.timeout(1000) });
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
    throw new Error("Workerd integration check failed");
  console.log(
    "Workerd: React Email rendering and Apple signed-data verifier initialization passed; forged JWS rejected.",
  );
} finally {
  child.kill();
  await child.exited;
  const output = (await stdout) + (await stderr);
  if (child.exitCode !== 0 && output.includes("Uncaught")) console.error(output);
}
export {};
