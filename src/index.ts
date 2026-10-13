import { app } from "./app";
import { connectDb } from "./db/client";
import { parseEnv, type Env } from "./env";
import { Vault } from "./lib/crypto";
import { dispatch } from "./services/notifications";
import { notificationTransport, pollExpoReceipts } from "./integrations/notifications";
import { BillingService } from "./services/billing";
import { tick } from "./services/scheduler";
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, bindings: Env, _ctx: ExecutionContext) {
    const env = parseEnv(bindings),
      { db, client } = connectDb(env);
    try {
      await new BillingService(db, env).refreshDue();
      await tick(db, env);
      await dispatch(db, env, new Vault(env), notificationTransport(env));
      await pollExpoReceipts(db, env);
    } finally {
      client.close();
    }
  },
} satisfies ExportedHandler<Env>;
