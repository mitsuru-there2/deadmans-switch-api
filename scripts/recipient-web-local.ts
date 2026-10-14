// Ephemeral local QA only. No provider, persisted credentials, production bindings or external email.
import { eq } from "drizzle-orm";
import { fixture } from "../tests/helpers";
import { outbox } from "../src/db/schema";
import type { Notice } from "../src/services/notifications";
import { DAY } from "../src/services/switch";
import { tick } from "../src/services/scheduler";
const f = await fixture();
const origin = "http://localhost:8890";
f.env.BETTER_AUTH_URL = origin;
f.env.RECIPIENT_WEB_URL = origin;
f.env.TRUSTED_ORIGINS = origin;
const { owner } = await f.ready();
f.advance(30 * DAY);
await f.healthy();
await tick(f.db, f.env, f.now());
await f.flush();
f.advance(7 * DAY);
await f.healthy();
await tick(f.db, f.env, f.now());
const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
Bun.serve({
  hostname: "127.0.0.1",
  port: 8890,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__local")
      return new Response(
        `<!doctype html><html lang="ja"><title>ローカル受取テスト</title><p>宛先メール: family@example.jp（外部送信なし）</p><p><a href="${notice.url}">テストの伝言リンクを開く</a></p><p><a href="/__local/mail">ローカルの確認メールを見る</a></p></html>`,
        {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    if (url.pathname === "/__local/mail") {
      const rows = await f.db.select().from(outbox).where(eq(outbox.kind, "auth"));
      const last = rows.at(-1);
      const mail = last
        ? await f.service.vault.open<Notice>(last.payload, `outbox:${last.id}`)
        : null;
      return new Response(
        `<html lang="ja"><title>ローカルの確認メール</title>${mail ? `<a href="${mail.url}">メールアドレスを確認する</a>` : "確認メールはまだありません"}</html>`,
        {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        },
      );
    }
    if (url.pathname === "/__local/pause" && request.method === "POST") {
      await f.service.pause(owner.id);
      return Response.json({ paused: true });
    }
    return f.app.fetch(request, f.env);
  },
});
console.log("Local recipient QA: http://localhost:8890/__local (in-memory, no external delivery)");
