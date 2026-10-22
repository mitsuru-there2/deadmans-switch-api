import { defineScheduled } from "void";
import { connectDb } from "../src/db/client";
import { runtimeEnv } from "../src/runtime";
import { Vault } from "../src/lib/crypto";
import { BillingService } from "../src/services/billing";
import { tick } from "../src/services/scheduler";
import { dispatch } from "../src/services/notifications";
import { notificationTransport, pollExpoReceipts } from "../src/integrations/notifications";

export const cron = "* * * * *";
export default defineScheduled(async (_controller, bindings) => {
  const env = runtimeEnv(bindings),
    { db } = connectDb(env);
  await new BillingService(db, env).refreshDue();
  await tick(db, env);
  await dispatch(db, env, new Vault(env), notificationTransport(env));
  await pollExpoReceipts(db, env);
});
