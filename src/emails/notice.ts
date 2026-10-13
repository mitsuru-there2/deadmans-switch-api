import { createElement as h } from "react";
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Heading,
  Text,
  Button,
  Hr,
} from "@react-email/components";
import { render, toPlainText } from "@react-email/render";
import type { Notice } from "../services/notifications";

const copy: Record<Notice["template"], { subject: string; text: string; button: string }> = {
  contact_verification: {
    subject: "連絡先メールの確認 — 私に何かあったら",
    text: "このメールを警告の送信先・データの復旧先として登録します。登録を始めたアプリでリンクを開いて確認してください。有効期限は10分です。心当たりがなければ破棄してください。",
    button: "連絡先を確認する",
  },
  magic_link: {
    subject: "ログイン用リンク — 私に何かあったら",
    text: "このリンクで登録・ログインできます。有効期限は10分、一度だけ使えます。心当たりがなければ、このメールを破棄してください。",
    button: "ログインする",
  },
  invitation: {
    subject: "伝言の受け取りのご案内 — 私に何かあったら",
    text: "あなた宛の伝言の受け取りを依頼されています。今すぐ本文が公開されるものではありません。登録されたメールでログインし、受取条件を確認して承諾・辞退を選んでください。",
    button: "依頼を確認する",
  },
  reminder: {
    subject: "確認のお願い — 私に何かあったら",
    text: "アプリを開いて、本人確認をお願いします。",
    button: "アプリを開く",
  },
  warning: {
    subject: "伝言の通知前にご確認ください — 私に何かあったら",
    text: "一定期間、ご本人の確認がありません。設定した猶予期間を経過すると、事前に承諾された宛先へ伝言の閲覧入口を通知します。アプリで本人確認を行うか、監視を停止してください。これは死亡を確認した通知ではありません。",
    button: "本人確認・停止を行う",
  },
  final: {
    subject: "お預かりした伝言のご案内 — 私に何かあったら",
    text: "事前に設定された無反応期間と猶予期間が経過したため、お預かりした伝言をご案内します。死亡を確認したものではありません。受け取りを承諾したメールでログインすると閲覧できます。",
    button: "伝言を確認する",
  },
  self_test: {
    subject: "【テスト】通知の確認 — 私に何かあったら",
    text: "これはご本人宛のテスト通知です。宛先への公開・送信は行っていません。",
    button: "テストを確認する",
  },
};
export async function renderNotice(notice: Notice) {
  const content = copy[notice.template];
  const html = await render(
    h(
      Html,
      { lang: "ja" },
      h(Head),
      h(Preview, null, content.subject),
      h(
        Body,
        { style: { backgroundColor: "#f6f5f2", color: "#222", fontFamily: "sans-serif" } },
        h(
          Container,
          { style: { maxWidth: "560px", padding: "32px", backgroundColor: "#fff" } },
          h(Heading, { as: "h1", style: { fontSize: "22px" } }, content.subject),
          notice.senderName ? h(Text, null, `伝言の登録者: ${notice.senderName}`) : null,
          h(Text, { style: { lineHeight: "1.8" } }, content.text),
          notice.url
            ? h(
                Button,
                {
                  href: notice.url,
                  style: {
                    backgroundColor: "#254b47",
                    color: "#fff",
                    padding: "14px 22px",
                    borderRadius: "6px",
                  },
                },
                content.button,
              )
            : null,
          notice.expiresAt
            ? h(
                Text,
                null,
                `リンクの期限: ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(notice.expiresAt)}（日本時間）`,
              )
            : null,
          h(Hr),
          h(
            Text,
            { style: { fontSize: "12px", color: "#666" } },
            "私に何かあったら / このメールに伝言の本文は含まれていません。",
          ),
        ),
      ),
    ),
  );
  return { subject: content.subject, html, text: toPlainText(html) };
}
