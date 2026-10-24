// External provider boundaries only. This module never supplies a DB or bypasses app authentication.
import { AppError } from "../../src/lib/errors";
import { renderNotice } from "../../src/emails/notice";
import type { Notice, Transport, TransportResult } from "../../src/services/notifications";
import type { StoreVerifier, VerifiedSubscription } from "../../src/integrations/stores";
export const providerState = {
  purchases: {} as Record<string, VerifiedSubscription>,
  captured: [] as Array<{ id: string; notice: Notice; html: string }>,
  result: "accepted" as "accepted" | "failed" | "uncertain",
  calls: [] as string[],
};
export const transport: Transport = async (id, notice) => {
  if (!providerState.captured.some((x) => x.id === id))
    providerState.captured.push({
      id,
      notice,
      html: notice.channel === "email" ? (await renderNotice(notice)).html : "",
    });
  return providerState.result === "accepted"
    ? { state: "accepted", providerId: `e2e:${id}` }
    : ({ state: providerState.result } as TransportResult);
};
function purchase(reference: string) {
  providerState.calls.push(reference);
  const result = providerState.purchases[reference];
  if (!result) throw new AppError(403, "PURCHASE_NOT_REGISTERED");
  return result;
}
export const storeVerifier: StoreVerifier = {
  async verify(_store, reference) {
    return purchase(reference);
  },
  async restore(proof) {
    return purchase(proof.store === "apple" ? proof.signedTransaction : proof.purchaseToken);
  },
  async appleNotification(payload) {
    if (!payload.startsWith("valid:")) throw new AppError(401, "INVALID_APPLE_SIGNATURE");
    const reference = payload.slice(6);
    const p = purchase(reference);
    return { id: `apple:${payload}`, reference: p.reference, accountToken: p.accountToken };
  },
  async googlePushAuthorization(token) {
    if (token !== "e2e-valid") throw new AppError(401, "INVALID_GOOGLE_SIGNATURE");
  },
};
