# RevenueCatサーバー橋渡しの検討

2026-10-14。既存Apple/Google直接検証を権利の正とし、購入権利の更新と本人データへの復旧を別に扱います。新しい公開ルート・キー・サービス設定・本番権利更新は追加していません。

## 公式仕様から分かること

RevenueCat WebhookはAuthorizationヘッダーを設定でき、HMAC署名も設定できます。署名は `X-RevenueCat-Webhook-Signature: t=...,v1=...`、秒単位時刻と生JSONのHMAC-SHA256です。再送時は署名時刻が更新され、イベントIDは維持されます。Webhook受信後のREST API再照会が推奨されています。[公式Webhook仕様](https://www.revenuecat.com/docs/integrations/webhooks)

イベントのapp_user_idは最後に観測したIDで、aliasesは過去のID群です。transaction_idはストア取引IDであり、Google purchaseTokenやApple署名JWSそのものではありません。country_codeは最後に観測した場所に由来するため、現APIのストア購入地域検証に置き換えません。TESTや一時的な権利付与イベントも存在します。[公式イベント仕様](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields)

REST APIはサーバー側から状態照会できますが、V2には権限付きのV2秘密キーが必要です。秘密キーをアプリへ配布しません。[公式REST API](https://www.revenuecat.com/docs/api-v2)、[APIキー](https://www.revenuecat.com/docs/projects/authentication)

SDKのApp User IDや復元時のtransfer/aliasはRevenueCat内の顧客識別と権利移転の仕組みです。現アプリの端末Bearerや受取メール認証と同じ本人証明ではありません。設定によって復元で別IDへ権利が移るため、これを秘密の伝言データ移管の自動許可に流用しません。[顧客ID](https://www.revenuecat.com/docs/customers/user-ids)、[復元時の動作](https://www.revenuecat.com/docs/projects/restore-behavior)

## 今回コードで検証した最小範囲

`src/integrations/revenuecat.ts`に未接続の検証部品を実装しました。

- Authorization＋HMAC、±5分の署名時刻、サイズ、app_id、環境を検証し、秘密を含むsubscriber_attributes等は返却しません。
- Appleの対応イベントから取引IDの照会ヒントだけを取り出します。認証済み所有者のprofile IDとapp_user_idの完全一致を要求し、さらに既存StoreVerifierで現在のストア状態とaccountTokenを再検証します。
- TRANSFER・Family Sharing・TEST・一時的な権利付与を所有者の証明として採用しません。Google注文番号をpurchaseTokenに変換しません。
- DB書込・権利付与・ownerVerifiedAt更新・端末発行・復旧を行いません。したがって重複イベントによる権利の二重更新も起きません。

モック試験は署名改ざん、古い署名、別アプリ/環境、別所有者、aliasesによる迂回、Google注文番号、ストアがexpiredを返す場合を含みます。HTTPルートに配線する前には、イベントIDによるDB重複排除・永続キュー・順序逆転の再照会・失敗時再試行の設計が必要です。現在のWebhook群と二重に権利を書き換えません。

## 可能な範囲と不可能な代替

Appleの既存所有者については、サーバーが認証済みWebhook/RESTから取引IDを見つけ、Appleへ再照会して厳密なaccountToken一致を確認する橋渡しが可能です。ただしRevenueCatの対象SDKで購入時に設定されるappAccountTokenとの一致は実機で確認が必要です。

AndroidはSDK 10.13.0購入結果のpurchaseTokenを既存APIへ渡す方が直接的です。RevenueCat Android 10.27.0 の Base64(SHA-256(appUserID)) に合わせ、本人プロフィールとの照合・UUIDでの保存・登録済み購入からのWebhook所有者解決・復旧を互換追加しました。通常購入とネイティブ証明取得の接続手順は[アプリ契約](app-contract.md)を参照してください。Webhookの注文番号では必要なトークンを代替できません。

端末を失った所有者の復旧について、サーバーが既知の取引を取得できることは、要求している新端末が本人である証明になりません。CustomerInfo、app_user_id、aliases、TRANSFER、サーバー側Apple JWS取得だけで復旧を許可しません。現行のストア証明を端末から取得する方式か、既存の確認済みメール復旧を使います。RevenueCatにクライアントから任意設定できる属性へchallengeを載せるだけの方式も採用しません。

## 判断が必要な点

1. 現在は既存の直接ストア検証を維持し、SDK/小さなネイティブブリッジで不足証明を取得する方向です。RevenueCatを権利の正へ移行する案は採用せず、この検証部品も未接続です。
2. Apple復旧用JWS取得ブリッジのネイティブ実装・実機検証と、証明取得不可/複数購入候補時の利用者フロー。購入番号だけによる復旧は選択肢にしません。
3. RevenueCatの復元/transfer設定とアカウント統合方針。ストア横断移行は引き続き対象外です。

これらを確定後、必要な設定値を別途用意して実ストアの購入・更新・返金・無料体験・応答喪失・復元を検証します。この作業では設定変更やキー発行はしていません。
