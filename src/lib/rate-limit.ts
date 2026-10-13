import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { publicRateLimits } from "../db/schema";
import { hash } from "./crypto";
import { AppError } from "./errors";
export async function rateLimit(
  db: Database,
  identity: string,
  scope: string,
  max = 60,
  windowMs = 60_000,
  now = Date.now(),
) {
  const key = await hash(`${scope}:${identity}:${Math.floor(now / windowMs)}`);
  const row = (
    await db
      .insert(publicRateLimits)
      .values({ key, count: 1, expiresAt: now + windowMs })
      .onConflictDoUpdate({
        target: publicRateLimits.key,
        set: { count: sql`${publicRateLimits.count} + 1` },
      })
      .returning()
  )[0];
  if (!row || row.count > max) throw new AppError(429, "RATE_LIMITED");
}
