import { env } from "void/env";
import { parseEnv, valuesSchema } from "./config";
export function runtimeEnv(bindings: { DB: D1Database }) {
  return parseEnv({ ...valuesSchema.parse(env), DB: bindings.DB });
}
