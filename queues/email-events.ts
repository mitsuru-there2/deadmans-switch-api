import { defineQueue } from "void";
import { connectDb } from "../src/db/client";
import { runtimeEnv } from "../src/runtime";
import { processEmailEvent } from "../src/integrations/notifications";
export const maxRetries = 10;
export const retryDelay = 60;
export default defineQueue<unknown>(async (batch, bindings) => {
  const { db } = connectDb(runtimeEnv(bindings));
  for (const message of batch.messages) {
    try {
      await processEmailEvent(db, message.body);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
});
