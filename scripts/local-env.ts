import { parseEnv } from "node:util";
export async function localEnv() {
  const path = Bun.file(".env");
  if (!(await path.exists())) throw new Error("Run bun run setup:local first");
  return parseEnv(await path.text());
}
