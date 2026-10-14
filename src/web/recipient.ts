// Static shells only. Recipient identity, link tokens and message snapshots are never interpolated.
export const recipientHtml = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive">
<title>伝言の受け取り | 私に何かあったら</title>
<link rel="stylesheet" href="/recipient-assets/style.css"><script src="/recipient-assets/app.js" defer></script></head>
<body><header><span class="brand">私に何かあったら</span><span class="sub">伝言の受け取り</span></header>
<main><p class="step" id="step">01 / メールの確認</p><h1 id="heading">あなた宛ての伝言を<br>安全に受け取るために。</h1>
<p id="status" role="status" aria-live="polite"></p>
<section id="auth"><p>通知が届いたメールアドレスを確認します。本文はまだ表示されません。</p>
<form id="login"><label for="email">通知を受け取ったメールアドレス</label><input id="email" type="email" autocomplete="email" required maxlength="254"><button type="submit">確認メールを受け取る</button></form>
<p class="hint">確認メールのリンクを開いたあと、この画面へ戻ってください。</p>
<button id="continue" class="secondary" type="button">メール確認が済んだので続ける</button></section>
<section id="preview" hidden><p id="sender"></p><p id="notice" class="notice"></p><p id="expiry" class="hint"></p>
<form id="opening" hidden><label class="check"><input type="checkbox" id="confirmed" required><span>送信者が亡くなったことを、別の手段で確認しました。</span></label><button id="open" type="submit" disabled>死亡を確認しました。伝言を開く</button></form>
<button id="accept" type="button" hidden>今後の伝言リンクを受け取ることに同意する</button>
<div class="minor-actions"><button id="decline" type="button" class="text-button">受け取りを辞退</button><button id="report" type="button" class="text-button">心当たりがない・通報</button></div></section>
<section id="message" hidden><h2 id="message-title"></h2><div id="message-body"></div><button id="hide" type="button" class="secondary">伝言を閉じる</button></section>
<section id="decision" hidden><p id="decision-copy"></p><button id="decision-confirm" type="button">確定する</button><button id="decision-cancel" type="button" class="secondary">戻る</button></section>
<button id="exit" type="button" class="text-button">開かずに終了する</button>
<noscript><p>安全な受け取り手続きにはJavaScriptが必要です。JavaScriptを有効にして、通知のリンクを開き直してください。</p></noscript></main>
<footer>このサービスは、送信者の死亡を確認するものではありません。</footer></body></html>`;

export const authCompleteHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>メール確認 | 私に何かあったら</title><link rel="stylesheet" href="/recipient-assets/style.css"><script src="/recipient-assets/auth.js" defer></script></head><body><header><span class="brand">私に何かあったら</span></header><main><p class="step">メールの確認</p><h1>受け取り画面へ<br>戻ってください。</h1><p id="auth-status" role="status">確認状態を調べています。</p><p>元の画面で「メール確認が済んだので続ける」を押してください。画面が閉じている場合は、最初の通知リンクを開き直してください。</p><p class="hint">この画面では伝言を開きません。</p></main></body></html>`;

export const recipientCss = `:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;color:#25372f;background:#f8f8f3;font-size:16px}*{box-sizing:border-box}body{margin:0}header{padding:28px max(24px,calc((100vw - 1080px)/2));border-bottom:1px solid #d9ded7;display:flex;justify-content:space-between;gap:16px;align-items:baseline}.brand{font-weight:650;font-size:22px;letter-spacing:.04em}.sub,.hint,footer{color:#59655e;font-size:14px}main{max-width:640px;margin:64px auto 80px;padding:0 24px}h1{font-size:clamp(26px,5vw,38px);line-height:1.55;font-weight:600;letter-spacing:.025em;margin:16px 0 32px}.step{font-size:12px;letter-spacing:.12em;color:#546b5d}p{line-height:1.85}label{display:block;font-size:14px;margin:28px 0 10px}input[type=email]{width:100%;font:inherit;border:1px solid #829184;background:#fff;padding:15px;border-radius:5px}button{display:block;width:100%;border:1px solid #315b47;border-radius:5px;background:#315b47;color:#fff;font:inherit;font-weight:600;line-height:1.5;padding:15px 18px;margin:16px 0;min-height:48px;cursor:pointer;transition:background-color .15s}button:hover{background:#264936}button:disabled{opacity:.5;cursor:default}.secondary{background:transparent;color:#315b47}.secondary:hover{background:#e6ede6}.text-button{width:auto;background:none;border:0;color:#405d4e;text-decoration:underline;font-size:14px;padding:12px 0;margin:12px 0}.text-button:hover{background:none;color:#142c20}.minor-actions{display:flex;justify-content:space-between;gap:20px;border-top:1px solid #d9ded7;margin-top:28px}.check{display:flex;align-items:flex-start;gap:12px;line-height:1.8;font-size:16px}.check input{width:22px;height:22px;flex-shrink:0;accent-color:#315b47;margin-top:3px}.notice{border-left:3px solid #7a917e;padding-left:20px;margin:28px 0;white-space:pre-line}#status:empty{display:none}#status{padding:14px 0;color:#714922}#message-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:2}#message-title{overflow-wrap:anywhere;line-height:1.6}footer{max-width:640px;padding:24px;margin:auto;border-top:1px solid #d9ded7}a,button,input{outline-offset:4px}:focus-visible{outline:3px solid #6b8a75}[hidden]{display:none!important}@media(max-width:600px){header{padding:22px 24px}.sub{display:none}main{margin-top:36px}.brand{font-size:20px}}@media(prefers-reduced-motion:reduce){button{transition:none}}`;

export const authCompleteScript = `"use strict";
history.replaceState(null, "", location.pathname);
fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" })
.then(r => r.ok ? r.json() : null).then(data => { document.getElementById("auth-status").textContent = data?.user?.emailVerified ? "メールの確認が完了しました。" : "メールを確認できませんでした。元の画面から確認メールを再発行してください。"; })
.catch(() => { document.getElementById("auth-status").textContent = "通信できませんでした。元の画面に戻り、もう一度確認してください。"; });`;

export const recipientScript = `"use strict";
(() => {
  const el = id => document.getElementById(id);
  const isInvitation = location.pathname === "/invitations";
  let token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) token = "";
  let noticeVersion = "", busy = false, generation = 0, controller, decision = "";
  const sections = ["auth", "preview", "message", "decision"];
  function show(id) { for (const name of sections) el(name).hidden = name !== id; }
  function controls() {
    for (const button of document.querySelectorAll("button")) button.disabled = busy;
    el("exit").disabled = false;
    el("open").disabled = busy || !el("confirmed").checked || !noticeVersion;
  }
  function clearPrivate() {
    el("message-title").textContent = "";
    el("message-body").textContent = "";
    el("sender").textContent = "";
    el("notice").textContent = "";
    el("expiry").textContent = "";
    el("confirmed").checked = false;
    noticeVersion = "";
  }
  function reset(forget, message) {
    generation++; controller?.abort(); busy = false; decision = "";
    clearPrivate();
    if (forget) { token = ""; el("email").value = ""; }
    show(token ? "auth" : "");
    el("status").textContent = message;
    el("heading").textContent = forget ? "受け取り画面を閉じました。" : "伝言を開く前に。";
    el("step").textContent = "受け取りの確認";
    controls();
  }
  const errorText = {
    AUTHENTICATION_REQUIRED: "メールの確認が必要です。確認メールのリンクを開いてから、続けるボタンを押してください。",
    VERIFIED_EMAIL_REQUIRED: "通知が届いたメールアドレスを確認してください。",
    NOT_FOUND: "このリンクでは受け取れません。宛先のメールアドレス、期限、送信者による停止をご確認ください。",
    OPENING_NOTICE_VERSION_REQUIRED: "注意事項が更新されました。続けるボタンから内容を読み直し、改めて確認してください。",
    INVALID_REQUEST: "確認内容を送信できませんでした。通知リンクを開き直してください。",
    RATE_LIMITED: "操作が続いたため、時間をおいてからお試しください。",
  };
  async function api(path, body, epoch) {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json();
    if (epoch !== generation) throw new Error("CANCELLED");
    if (!response.ok) throw new Error(data?.error?.code || (response.status === 429 ? "RATE_LIMITED" : "REQUEST_FAILED"));
    return data;
  }
  async function run(operation) {
    if (busy || !token) return;
    busy = true; controller = new AbortController(); controls();
    const epoch = generation;
    el("status").textContent = "確認しています…";
    try { await operation(epoch); }
    catch (error) {
      if (epoch !== generation) return;
      clearPrivate(); show("auth");
      el("status").textContent = errorText[error.message] || "通信結果を確認できませんでした。自動では再送しません。続けるボタンで状態を確認してください。";
    } finally { if (epoch === generation) { busy = false; controls(); } }
  }
  el("login").addEventListener("submit", event => {
    event.preventDefault();
    if (!el("login").reportValidity()) return;
    void run(async epoch => {
      await api("/api/auth/sign-in/magic-link", { email: el("email").value.trim(), callbackURL: location.origin + "/recipient-auth" }, epoch);
      el("status").textContent = "確認メールの送信を受け付けました。メールのリンクを開き、この画面に戻ってください。";
    });
  });
  el("continue").addEventListener("click", () => void run(async epoch => {
    clearPrivate();
    const data = await api(isInvitation ? "/v1/invitations/preview" : "/v1/received", isInvitation ? { token } : { token, action: "preview" }, epoch);
    el("sender").textContent = data.senderName + " さんからの" + (isInvitation ? "受取依頼です。" : "伝言です。");
    el("expiry").textContent = "リンクの有効期限：" + new Date(data.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + "（日本時間）";
    el("notice").textContent = isInvitation ? "今後、送信者からの確認が一定期間なく、猶予期間が経過した場合に伝言リンクを受け取ることへの同意です。今は本文を開きません。伝言が届いた際の死亡確認と開封同意は、別の手続きです。" : data.notice;
    noticeVersion = isInvitation ? "" : data.noticeVersion;
    el("opening").hidden = isInvitation;
    el("accept").hidden = !isInvitation;
    el("heading").textContent = isInvitation ? "伝言リンクの受け取りについて。" : "開く前に、ご確認ください。";
    el("step").textContent = "02 / " + (isInvitation ? "受取依頼の確認" : "開封前の確認");
    el("status").textContent = ""; show("preview");
  }));
  el("confirmed").addEventListener("change", controls);
  el("opening").addEventListener("submit", event => {
    event.preventDefault();
    if (!el("confirmed").checked || !noticeVersion || isInvitation) return;
    void run(async epoch => {
      const data = await api("/v1/received", { token, action: "read", deathConfirmed: true, noticeVersion }, epoch);
      el("message-title").textContent = data.message.title;
      el("message-body").textContent = data.message.body;
      el("confirmed").checked = false; noticeVersion = "";
      el("heading").textContent = "あなたへの伝言。"; el("step").textContent = "03 / 伝言";
      el("status").textContent = ""; show("message"); el("hide").focus();
    });
  });
  el("accept").addEventListener("click", () => void run(async epoch => {
    await api("/v1/invitations/respond", { token, action: "accept" }, epoch);
    reset(true, "受け取りに同意しました。伝言が届く場合は、改めてリンクをお送りします。");
  }));
  for (const action of ["decline", "report"]) el(action).addEventListener("click", () => {
    if (busy) return;
    decision = action; show("decision");
    el("confirmed").checked = false;
    el("decision-copy").textContent = action === "decline" ? "受け取りを辞退します。この宛先の伝言は開けなくなります。" : "心当たりのない受取依頼として通報します。この宛先の伝言は開けなくなります。";
  });
  el("decision-cancel").addEventListener("click", () => { decision = ""; show("preview"); controls(); });
  el("decision-confirm").addEventListener("click", () => {
    if (!decision) return;
    void run(async epoch => {
      await api(isInvitation ? "/v1/invitations/respond" : "/v1/received", { token, action: decision }, epoch);
      reset(true, "受け取りの停止を受け付けました。");
    });
  });
  el("hide").addEventListener("click", () => reset(false, "伝言を閉じました。もう一度開く場合も、注意事項の確認が必要です。"));
  el("exit").addEventListener("click", () => reset(true, "本文を表示せず終了できます。必要になったら、通知のリンクを開き直してください。"));
  addEventListener("pagehide", () => reset(true, "通知のリンクを開き直してください。"));
  addEventListener("popstate", () => reset(true, "通知のリンクを開き直してください。"));
  addEventListener("pageshow", event => { if (event.persisted) reset(true, "通知のリンクを開き直してください。"); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) reset(false, "本文を隠しました。続けるボタンから改めて確認してください。"); });
  if (!token) reset(true, "通知のリンクから開き直してください。リンク情報は端末に保存していません。");
  else if (isInvitation) el("heading").textContent = "伝言リンクの受取依頼が届いています。";
  controls();
})();`;
