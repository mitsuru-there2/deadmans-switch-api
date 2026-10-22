import { atomic } from "../db/client";
import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import {
  deviceCredentials,
  profiles,
  restoreOperations,
  storeSubscriptions,
  user,
} from "../db/schema";
import type { Env } from "../config";
import type { RestorePurchaseProof } from "../integrations/stores";
import { hash, Vault } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { bootstrapResponseSchema, type BootstrapResponse } from "../responses";
import { DAY } from "./switch";

export const RESTORE_RESULT_TTL = 15 * 60_000;
export type RestoreOperation = Pick<
  typeof restoreOperations.$inferSelect,
  "id" | "sourceTokenHash" | "secretHash" | "requestHash"
>;
const unavailable = () => new AppError(404, "RESTORE_RESULT_UNAVAILABLE");

export class RestoreOperations {
  private vault: Vault;
  constructor(
    private db: Database,
    env: Env,
    private now: () => number = Date.now,
  ) {
    this.vault = new Vault(env);
  }
  async begin(
    userId: string,
    token: string,
    secret: string,
    proof: RestorePurchaseProof,
  ): Promise<RestoreOperation> {
    const sourceTokenHash = await hash(token),
      secretHash = await hash(secret);
    // Explicit fields make the fingerprint independent of JSON key order and exclude the operation secret.
    const requestHash = await hash(
      JSON.stringify(
        proof.store === "apple"
          ? { store: proof.store, signedTransaction: proof.signedTransaction }
          : { store: proof.store, purchaseToken: proof.purchaseToken },
      ),
    );
    return atomic(this.db, async (tx) => {
      const existing = (
        await tx
          .select()
          .from(restoreOperations)
          .where(
            or(
              eq(restoreOperations.sourceTokenHash, sourceTokenHash),
              eq(restoreOperations.secretHash, secretHash),
            ),
          )
      )[0];
      if (existing) {
        if (
          existing.sourceTokenHash !== sourceTokenHash ||
          existing.secretHash !== secretHash ||
          existing.requestHash !== requestHash
        )
          throw new AppError(409, "RESTORE_OPERATION_CONFLICT");
        if (existing.expiresAt <= this.now()) throw new AppError(409, "RESTORE_OPERATION_EXPIRED");
        if (existing.state === "failed") throw new AppError(409, "RESTORE_OPERATION_FAILED");
        return existing;
      }
      const credential = (
        await tx
          .select()
          .from(deviceCredentials)
          .where(
            and(
              eq(deviceCredentials.userId, userId),
              eq(deviceCredentials.tokenHash, sourceTokenHash),
              gt(deviceCredentials.expiresAt, this.now()),
            ),
          )
      )[0];
      if (!credential) throw new AppError(401, "DEVICE_AUTHENTICATION_REQUIRED");
      const p = (await tx.select().from(profiles).where(eq(profiles.userId, userId)))[0];
      const u = (await tx.select().from(user).where(eq(user.id, userId)))[0];
      const purchases = p
        ? await tx
            .select({ id: storeSubscriptions.id })
            .from(storeSubscriptions)
            .where(eq(storeSubscriptions.profileId, p.id))
            .limit(1)
        : [];
      if (!p || !u || u.emailVerified || p.version !== 1 || p.state !== "draft" || purchases.length)
        throw new AppError(409, "RESTORE_REQUIRES_FRESH_DEVICE_IDENTITY");
      const value = {
        id: crypto.randomUUID(),
        sourceTokenHash,
        secretHash,
        requestHash,
        state: "pending" as const,
        expiresAt: Math.min(this.now() + RESTORE_RESULT_TTL, credential.expiresAt),
        purgeAt: this.now() + DAY,
      };
      await tx.insert(restoreOperations).values(value);
      return value;
    });
  }
  async inspect(tx: Tx, operation: RestoreOperation) {
    const row = (
      await tx
        .select()
        .from(restoreOperations)
        .where(
          and(
            eq(restoreOperations.id, operation.id),
            eq(restoreOperations.secretHash, operation.secretHash),
            eq(restoreOperations.sourceTokenHash, operation.sourceTokenHash),
            eq(restoreOperations.requestHash, operation.requestHash),
          ),
        )
    )[0];
    if (!row || row.expiresAt <= this.now()) throw unavailable();
    return row;
  }
  private async session(
    tx: Tx,
    row: typeof restoreOperations.$inferSelect,
  ): Promise<BootstrapResponse> {
    if (!row.result || !row.resultTokenHash || !row.targetUserId) throw unavailable();
    const credential = (
      await tx
        .select()
        .from(deviceCredentials)
        .where(
          and(
            eq(deviceCredentials.tokenHash, row.resultTokenHash),
            eq(deviceCredentials.userId, row.targetUserId),
            gt(deviceCredentials.expiresAt, this.now()),
          ),
        )
    )[0];
    if (!credential) throw unavailable();
    const value = bootstrapResponseSchema.parse(
      await this.vault.open(row.result, `restore-result:${row.id}`),
    );
    if (
      (await hash(value.token)) !== row.resultTokenHash ||
      value.userId !== row.targetUserId ||
      row.expiresAt <= this.now() ||
      credential.expiresAt <= this.now()
    )
      throw unavailable();
    return value;
  }
  async completed(tx: Tx, operation: RestoreOperation) {
    const row = await this.inspect(tx, operation);
    if (row.state === "failed") throw new AppError(409, "RESTORE_OPERATION_FAILED");
    return row.state === "completed" ? this.session(tx, row) : null;
  }
  async complete(tx: Tx, operation: RestoreOperation, value: BootstrapResponse) {
    const row = await this.inspect(tx, operation);
    if (row.state !== "pending") throw new AppError(409, "RESTORE_OPERATION_CONFLICT");
    const result = await this.vault.seal(value, `restore-result:${row.id}`);
    if (row.expiresAt <= this.now()) throw unavailable();
    await tx
      .update(restoreOperations)
      .set({
        state: "completed",
        result,
        resultTokenHash: await hash(value.token),
        targetUserId: value.userId,
      })
      .where(eq(restoreOperations.id, row.id));
    await this.inspect(tx, operation);
  }
  async fail(operation: RestoreOperation, error: unknown) {
    // Transient failures can retry the exact proof while the original fresh credential remains live.
    if (!(error instanceof AppError) || error.status === 503 || error.status === 429) return;
    await this.db
      .update(restoreOperations)
      .set({ state: "failed", errorCode: error.code })
      .where(
        and(
          eq(restoreOperations.id, operation.id),
          eq(restoreOperations.state, "pending"),
          gt(restoreOperations.expiresAt, this.now()),
        ),
      );
  }
  async result(token: string, secret: string) {
    if (!/^dms_[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
    const sourceTokenHash = await hash(token),
      secretHash = await hash(secret);
    return atomic(this.db, async (tx) => {
      const row = (
        await tx
          .select()
          .from(restoreOperations)
          .where(
            and(
              eq(restoreOperations.sourceTokenHash, sourceTokenHash),
              eq(restoreOperations.secretHash, secretHash),
            ),
          )
      )[0];
      if (!row || row.expiresAt <= this.now()) throw unavailable();
      if (row.state === "completed")
        return {
          status: "completed" as const,
          session: await this.session(tx, row),
          expiresAt: row.expiresAt,
        };
      // Pending/failed information is available only while that fresh device remains valid.
      const source = (
        await tx
          .select({ id: deviceCredentials.id })
          .from(deviceCredentials)
          .where(
            and(
              eq(deviceCredentials.tokenHash, sourceTokenHash),
              gt(deviceCredentials.expiresAt, this.now()),
            ),
          )
      )[0];
      if (!source) throw unavailable();
      if (row.state === "failed")
        return {
          status: "failed" as const,
          error: { code: row.errorCode ?? "RESTORE_OPERATION_FAILED" },
          expiresAt: row.expiresAt,
        };
      return { status: "pending" as const, expiresAt: row.expiresAt };
    });
  }
}

export async function purgeRestoreResults(db: Database, now: number) {
  await atomic(db, async (tx) => {
    // An abandoned fresh credential must not start the old operation again after its tombstone is purged.
    await tx
      .delete(deviceCredentials)
      .where(
        inArray(
          deviceCredentials.tokenHash,
          tx
            .select({ hash: restoreOperations.sourceTokenHash })
            .from(restoreOperations)
            .where(lte(restoreOperations.expiresAt, now)),
        ),
      );
    await tx
      .update(restoreOperations)
      .set({ result: null, resultTokenHash: null })
      .where(lte(restoreOperations.expiresAt, now));
    await tx.delete(restoreOperations).where(lte(restoreOperations.purgeAt, now));
  });
}
