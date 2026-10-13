export async function localEnv() {
  const path = Bun.file(".dev.vars");
  if (!(await path.exists())) throw new Error("Run bun run setup:local first");
  return Object.fromEntries(
    (await path.text())
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const split = line.indexOf("=");
        let value = line.slice(split + 1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        return [line.slice(0, split), value];
      }),
  );
}
