import { defineHandler } from "void/handler";
import { app } from "dms-runtime-app";
import { runtimeEnv } from "./runtime";

// The published Hono Client and security/authentication middleware remain the HTTP contract.
export const handle = defineHandler((c) => app.fetch(c.req.raw, runtimeEnv(c.env), c.executionCtx));
