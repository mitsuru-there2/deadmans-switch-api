import { afterEach, beforeEach, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { eq } from "drizzle-orm";
import { deliveries, openingConsents, outbox } from "../src/db/schema";
import { recipientHtml, recipientScript } from "../src/web/recipient";
import { DAY } from "../src/services/switch";
import { tick } from "../src/services/scheduler";
import type { Notice } from "../src/services/notifications";
import { fixture, type Fixture } from "./helpers";
let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(() => f.client.close());
async function released() {
  const ready = await f.ready();
  f.advance(30 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  await f.flush();
  f.advance(7 * DAY);
  await f.healthy();
  await tick(f.db, f.env, f.now());
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "final")))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  return { ...ready, token: notice.url!.split("#")[1]! };
}
type Handler = (event: Record<string, unknown>) => void;
class Element {
  textContent = "";
  value = "";
  hidden = false;
  checked = false;
  disabled = false;
  events = new Map<string, Handler>();
  addEventListener(name: string, callback: Handler) {
    this.events.set(name, callback);
  }
  reportValidity() {
    return true;
  }
  focus() {}
  fire(name = "click") {
    if (this.disabled && name === "click") return;
    this.events.get(name)?.({ preventDefault() {} });
  }
}
function browser(
  token: string,
  options: { cookie?: string; path?: string; stale?: boolean; delayRead?: Promise<void> } = {},
) {
  const ids = [...recipientHtml.matchAll(/id="([^"]+)"/g)].map((x) => x[1]!);
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const $ = (id: string) => elements[id]!;
  const listeners = new Map<string, Handler>();
  const document = {
    hidden: false,
    getElementById: $,
    querySelectorAll: () => [
      $("open"),
      $("continue"),
      $("accept"),
      $("decline"),
      $("report"),
      $("hide"),
      $("decision-confirm"),
      $("decision-cancel"),
      $("exit"),
    ],
    addEventListener(name: string, callback: Handler) {
      listeners.set(name, callback);
    },
  };
  const location = {
    hash: token ? `#${token}` : "",
    pathname: options.path ?? "/receive",
    origin: "http://localhost:8787",
  };
  const requests: Array<{ path: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const replacements: string[] = [];
  let cookie = options.cookie;
  runInNewContext(recipientScript, {
    document,
    location,
    history: {
      replaceState(_state: unknown, _title: string, path: string) {
        replacements.push(path);
        location.hash = "";
      },
    },
    addEventListener(name: string, callback: Handler) {
      listeners.set(name, callback);
    },
    AbortController,
    Date,
    fetch: async (path: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requests.push({ path, init, body });
      if (body.action === "read" && options.delayRead) await options.delayRead;
      const response = await f.request(
        path,
        "POST",
        options.stale && body.action === "read" ? { ...body, noticeVersion: "old" } : body,
        undefined,
        {
          Origin: location.origin,
          "Sec-Fetch-Site": "same-origin",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      );
      return response;
    },
  });
  return {
    $,
    document,
    requests,
    replacements,
    location,
    setCookie(value: string) {
      cookie = value;
    },
    event(name: string, data: Record<string, unknown> = {}) {
      listeners.get(name)?.(data);
    },
  };
}
async function settle(b: ReturnType<typeof browser>) {
  for (let i = 0; i < 100; i++) {
    if (!b.$("continue").disabled) return;
    await Bun.sleep(1);
  }
  throw new Error("UI operation did not settle");
}
async function authenticate(b: ReturnType<typeof browser>) {
  b.$("email").value = "family@example.jp";
  b.$("login").fire("submit");
  await settle(b);
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "auth"))).at(-1)!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  const verified = await f.app.request(notice.url!, {}, f.env);
  expect(verified.status).toBe(302);
  expect(verified.headers.get("location")).toBe("http://localhost:8787/recipient-auth");
  const cookies = verified.headers.get("set-cookie")!;
  const cookie = cookies.match(/better-auth\.session_token=[^;]+/)![0];
  b.setCookie(cookie);
  return cookie;
}
async function preview(b: ReturnType<typeof browser>) {
  b.$("continue").fire();
  await settle(b);
}
async function open(b: ReturnType<typeof browser>) {
  b.$("confirmed").checked = true;
  b.$("confirmed").fire("change");
  b.$("opening").fire("submit");
  await settle(b);
}

test("static pages, assets and callback reveal no private data and enforce restrictive headers", async () => {
  const { token } = await released();
  for (const path of [
    "/receive",
    "/invitations",
    "/recipient-auth",
    "/recipient-assets/app.js",
    "/recipient-assets/auth.js",
    "/recipient-assets/style.css",
  ]) {
    const response = await f.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    if (!path.includes("assets"))
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const content = await response.text();
    for (const secret of [token, "家族への機密メッセージ", "大切な伝言", "family@example.jp"])
      expect(content).not.toContain(secret);
  }
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
});

test("actual UI events run email authentication, body-free preview and explicit consent before disclosure", async () => {
  const { token } = await released();
  const b = browser(token);
  expect(b.location.hash).toBe("");
  expect(b.replacements).toEqual(["/receive"]);
  expect(b.requests).toHaveLength(0);
  await preview(b);
  expect(b.$("message-body").textContent).toBe("");
  expect(b.$("status").textContent).toContain("メールの確認が必要");
  await authenticate(b);
  expect(b.requests.find((r) => r.path.includes("magic-link"))!.body).toEqual({
    email: "family@example.jp",
    callbackURL: "http://localhost:8787/recipient-auth",
  });
  await preview(b);
  expect(b.$("preview").hidden).toBe(false);
  expect(b.$("message-body").textContent).toBe("");
  expect(b.$("confirmed").checked).toBe(false);
  expect(b.$("open").disabled).toBe(true);
  b.$("opening").fire("submit");
  await settle(b);
  expect(b.requests.filter((r) => r.body.action === "read")).toHaveLength(0);
  await open(b);
  expect(b.$("message").hidden).toBe(false);
  expect(b.$("message-title").textContent).toBe("大切な伝言");
  expect(b.$("message-body").textContent).toBe("家族への機密メッセージ");
  expect(await f.db.select().from(openingConsents)).toHaveLength(1);
  for (const request of b.requests) {
    expect(request.path).not.toContain(token);
    expect(request.init.referrerPolicy).toBe("no-referrer");
    expect(request.init.cache).toBe("no-store");
    expect(JSON.stringify(request.init.headers)).not.toContain(token);
  }
});

test("old notice and stop after preview do not show plaintext or keep a checked confirmation", async () => {
  const { token, owner } = await released();
  const b = browser(token, { stale: true });
  const cookie = await authenticate(b);
  await preview(b);
  await open(b);
  expect(b.$("message-body").textContent).toBe("");
  expect(b.$("confirmed").checked).toBe(false);
  expect(b.$("status").textContent).toContain("注意事項が更新");
  const c = browser(token, { cookie });
  await preview(c);
  await f.service.pause(owner.id);
  await open(c);
  expect(c.$("message-body").textContent).toBe("");
  expect(c.$("status").textContent).toContain("このリンクでは受け取れません");
});

test("double click sends one read; hiding while request is in flight discards late plaintext", async () => {
  const { token } = await released();
  let release!: () => void;
  const delayRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = browser(token, { delayRead });
  await authenticate(b);
  await preview(b);
  b.$("confirmed").checked = true;
  b.$("confirmed").fire("change");
  b.$("opening").fire("submit");
  b.$("opening").fire("submit");
  expect(b.requests.filter((r) => r.body.action === "read")).toHaveLength(1);
  b.document.hidden = true;
  b.event("visibilitychange");
  release();
  await Bun.sleep(30);
  expect(b.$("message-body").textContent).toBe("");
  expect(b.$("message").hidden).toBe(true);
  expect(b.$("confirmed").checked).toBe(false);
});

for (const event of ["pagehide", "popstate", "pageshow"])
  test(`${event}, reload and browser restoration never reopen or retain plaintext`, async () => {
    const { token } = await released();
    const b = browser(token);
    const cookie = await authenticate(b);
    await preview(b);
    await open(b);
    const before = b.requests.length;
    b.event(event, { persisted: true });
    expect(b.$("message-body").textContent).toBe("");
    expect(b.$("message").hidden).toBe(true);
    b.$("continue").fire();
    expect(b.requests).toHaveLength(before);
    const reload = browser("", { cookie });
    expect(reload.$("status").textContent).toContain("通知のリンクから開き直して");
    expect(reload.requests).toHaveLength(0);
  });

test("decline confirmation works before opening; cancelling leaves checkbox unset", async () => {
  const { token } = await released();
  const b = browser(token);
  await authenticate(b);
  await preview(b);
  b.$("confirmed").checked = true;
  b.$("decline").fire();
  b.$("decision-cancel").fire();
  expect(b.$("confirmed").checked).toBe(false);
  b.$("decline").fire();
  b.$("decision-confirm").fire();
  await settle(b);
  expect(b.$("status").textContent).toContain("受け取りの停止");
  expect(b.$("message-body").textContent).toBe("");
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
  expect((await f.db.select().from(deliveries))[0]!.revokedAt).not.toBeNull();
});

test("invitation acceptance remains separate from death confirmation and message opening", async () => {
  const owner = await f.createUser();
  await f.grant(owner.profile.id);
  const recipient = await f.service.addRecipient(owner.id, {
    version: 1,
    name: "家族",
    channel: "email",
    email: "family@example.jp",
  });
  await f.service.invite(owner.id, recipient.id);
  const job = (await f.db.select().from(outbox).where(eq(outbox.kind, "invitation")))[0]!;
  const notice = await f.service.vault.open<Notice>(job.payload, `outbox:${job.id}`);
  const b = browser(notice.url!.split("#")[1]!, { path: "/invitations" });
  await authenticate(b);
  await preview(b);
  expect(b.$("opening").hidden).toBe(true);
  expect(b.$("accept").hidden).toBe(false);
  expect(b.$("notice").textContent).toContain("別の手続き");
  b.$("accept").fire();
  await settle(b);
  expect(b.$("status").textContent).toContain("受け取りに同意");
  expect(b.requests.some((r) => r.body.action === "read")).toBe(false);
  expect(await f.db.select().from(openingConsents)).toHaveLength(0);
});
