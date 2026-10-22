import { defineEnv } from "void/env";
import { valuesSchema } from "./src/config.ts";
export default defineEnv(valuesSchema.shape);
