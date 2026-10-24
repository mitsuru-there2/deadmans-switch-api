import { defineHandler } from "void/handler";
import { providerState } from "../../tests/e2e/providers";
import { runtimeEnv } from "../../src/runtime";
import { secretEqual } from "../../src/lib/crypto";
export const GET = defineHandler(async (c) => {
  if (import.meta.env.MODE !== "e2e" || runtimeEnv(c.env).APP_ENV !== "test")
    return c.body(null, 404);
  if (
    !(await secretEqual(
      c.req.header("Authorization") ?? "",
      `Bearer ${runtimeEnv(c.env).OPERATIONS_SECRET}`,
    ))
  )
    return c.body(null, 401);
  return c.json(providerState);
});
export const POST = defineHandler(async (c) => {
  if (import.meta.env.MODE !== "e2e" || runtimeEnv(c.env).APP_ENV !== "test")
    return c.body(null, 404);
  if (
    !(await secretEqual(
      c.req.header("Authorization") ?? "",
      `Bearer ${runtimeEnv(c.env).OPERATIONS_SECRET}`,
    ))
  )
    return c.body(null, 401);
  const data = await c.req.json();
  if (data.purchases) Object.assign(providerState.purchases, data.purchases);
  if (["accepted", "failed", "uncertain"].includes(data.result)) providerState.result = data.result;
  return c.json({ ok: true });
});
