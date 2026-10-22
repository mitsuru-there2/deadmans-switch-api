import certificate from "./fixtures/AppleRootCA-G3.cer?inline";
import { renderNotice } from "../src/emails/notice";
import { createStoreVerifier } from "../src/integrations/stores";
import type { Env } from "../src/config";

// Isolated workerd compatibility check. No database, provider credentials or external delivery.
export default {
  async fetch() {
    const email = await renderNotice({
      channel: "email",
      to: "test@example.jp",
      template: "self_test",
      url: "https://example.jp/test",
    });
    const env = {
      APPLE_ROOT_CERTIFICATES: JSON.stringify([certificate.split(",")[1]]),
      APPLE_ENVIRONMENT: "Production",
      APPLE_BUNDLE_ID: "jp.example.app",
      APPLE_APP_ID: "123456789",
    } as Env;
    let appleRejected = false;
    try {
      await createStoreVerifier(env).appleNotification("forged-jws");
    } catch (error) {
      appleRejected = error instanceof Error && error.message === "INVALID_APPLE_SIGNATURE";
    }
    let appleRestoreRejected = false;
    try {
      await createStoreVerifier(env).restore({ store: "apple", signedTransaction: "forged-jws" });
    } catch (error) {
      appleRestoreRejected = error instanceof Error && error.message === "INVALID_APPLE_SIGNATURE";
    }
    return Response.json({
      reactEmail: email.html.includes("テスト") && email.text.includes("テスト"),
      appleRejected,
      appleRestoreRejected,
    });
  },
};
