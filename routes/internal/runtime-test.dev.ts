import { defineHandler } from "void/handler";
import runtime from "../../tests/runtime-worker";
import { runtimeEnv } from "../../src/runtime";
import { secretEqual } from "../../src/lib/crypto";
export const GET = defineHandler(async (c) => {
  if (
    !(await secretEqual(
      c.req.header("Authorization") ?? "",
      `Bearer ${runtimeEnv(c.env).OPERATIONS_SECRET}`,
    ))
  )
    return c.json({ error: "UNAUTHORIZED" }, 401);
  return runtime.fetch();
});
