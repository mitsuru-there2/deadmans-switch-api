# アプリ実装への引き継ぎ（2026-10-14）

## 共有型と接続

このリポジトリをworkspace/file依存にして `deadmans-switch-api/client` から `createApiClient` と `AppType` を利用できます。`src/client.ts` は実行時にHono Clientだけを読み込みます。`AppType` は実際のルートとZod入力validatorから推論します。`responses` は全 `/v1` JSON成功応答のZod schemaと画面用型です。OpenAPIも同じ応答schemaを配布します。エラーは成功型に含まれないため、`response.ok` を確認し、失敗JSONの `error.code` を処理してください。

```ts
import { createApiClient } from "deadmans-switch-api/client";
const api = createApiClient(baseUrl, {
  headers: async () => ({ Authorization: `Bearer ${await readSecureToken()}` }),
});
const response = await api.v1.me.$get();
if (response.ok) {
  const me = await response.json();
  // me.switch.serverTime, activationBlockers, consentVersion, deadlines
}
```

型: `SwitchStatus`, `ProfileResponse`, `MeResponse`, `Recipient`, `Message`, `Delivery`, `BillingAccount`, `SubscriptionsResponse`, `DeviceSession`, `BootstrapResponse`, `CurrentConsent`, `ActivationBlocker`, `ReceivedRequest`, `ReceivedResponse`。

## 互換追加と同意更新

- `GET /v1/me` / `GET /v1/switch`: `serverTime`（Unix ms）、`activationBlockers`。後者は表示用の現時点診断で、activateでも再検査します。active/grace/releasedは`PAUSE_BEFORE_EDITING`。監視ジョブの時刻・鍵などは公開しません。
- `GET /v1/recipients`: `invitationExpiresAt: number|null`、`nextInvitationAt: number|null`。pendingの未招待は現在サーバー時刻、再招待は前回+24時間、承諾/辞退/通報後はnull。監視状態や本人の日次上限は別に適用します。
- `POST /v1/self-test`: 202 `{queued:true,deliveryId}`。`GET /v1/deliveries` の同じIDを追跡し、accepted/deliveredを成功として表示。202/pendingはテスト成功ではありません。
- `GET /v1/consents/current`: 本人Bearer必須、未契約でも可。`{version,language:'ja',effectiveAt,title,body}`。所有者同意版は **2026-10-14-v2**。取得本文を省略せず表示し、明示同意後に同じversionをactivateのconsentVersionへ渡します。旧版は422 `CONSENT_VERSION_REQUIRED`。既に監視中の設定を自動停止/再同意済みにはしません。
- `POST /v1/received`: preview/read/decline/reportを明示指定。readはdeathConfirmed:trueとnoticeVersion必須。受取注意文版は **2026-10-14-v1**。所有者同意版と別です。

`PATCH /v1/switch` / activate / pause / check-ins は従来どおり `ProfileResponse` を返します。期限・診断を含む `SwitchStatus` と同一視せず、成功後にme/switchを再取得してください。SMSはサーバー内部enumに残るだけで、新規登録入力はemailのみです。

## 認証・復旧・再試行

bootstrap `{}` → `{token,expiresAt,accountToken,userId}`。端末Bearerは180日、device-sessionで直列更新しSecureStoreへ保存。応答喪失時に旧tokenが有効とは限りません。購入証明による復旧経路へ進みます。

同一ストア復元は新規bootstrapの端末Bearerと、Appleの署名付きTransaction JWS全体またはGoogle purchaseTokenが必須。元アカウントで認証付き購入検証を完了している必要があります。旧端末・セッション・Expo登録が失効し、新端末で通知を再登録します。復元そのものはチェックイン・監視再開ではありません。メール復旧は補助経路です。

編集は最新versionを送信、409で自動上書きせず利用者に確認。招待・テスト・削除・有効化は応答喪失を未実行と断定せず状態照合。汎用冪等性キーは未提供です。オフラインチェックインをバックグラウンド再送しません。

## RevenueCat：接続の未解決点

アプリにインストールされた `react-native-purchases 10.13.0` の実際の型を読込確認しました（`@revenuecat/purchases-typescript-internal/dist/{callbackTypes,customerInfo}.d.ts`）。MakePurchaseResult.transactionはtransactionIdentifierとAndroid purchaseTokenを持ちますが、purchaseTokenはnull許容です。Appleの署名付きJWSはこの型にありません。restorePurchasesはCustomerInfoだけを返すため、これをAPI復旧証明に置換できません。

AndroidのRevenueCatネイティブ実装はappUserIDのSHA-256をobfuscatedAccountIdに設定します。現APIはprofile UUIDそのものとの厳密一致であり、`appUserID=accountToken` だけでは一致しません。注文番号をpurchaseTokenとして送ることもできません。参照: [公式Android実装](https://github.com/RevenueCat/purchases-android/blob/main/purchases/src/main/kotlin/com/revenuecat/purchases/google/BillingWrapper.kt)、[公式SDK型](https://github.com/RevenueCat/purchases-hybrid-common/blob/main/typescript/src/customerInfo.ts)、[React Native SDK](https://github.com/RevenueCat/react-native-purchases/blob/main/src/purchases.ts)。ネイティブ実装mainの確認は、対象ビルドに固定された依存版での実機検証を代替しません。

最小の安全な候補は、APIの直接検証を正のまま保持し、必要なネイティブストア証明を取り出すブリッジを追加する方式です。Android識別子をハッシュへ対応するなら、認証済みprofileとのサーバー計算照合、購入記録の正規化、Webhookからの所有者解決、復元時の元所有者判定まで一貫して設計・試験する必要があります。単に任意のハッシュを許可したり、CustomerInfoのisActiveで権利を付与しません。

別候補は [RevenueCatと自前IAP処理の併用](https://www.revenuecat.com/docs/migrating-to-revenuecat/sdk-or-not/finishing-transactions) です。StoreKit/Play Billingで現accountTokenを設定し証明を取得した後、RevenueCatへ同期します。購入完了/acknowledgeの担当、両OS実装、復元・移転設定の検証が増えるため、今回本番方式として採用していません。

RevenueCatサーバー権利へ移行する方式も未採用です。Webhookの認証、署名/共有秘密の管理、所有者紐付け、再送・順序、直接ストア通知との二重更新防止、失効最大24時間、同一ストア復旧証明を別途設計する必要があります。現APIの購入・復旧制約と権利の更新元は変更していません。

実ストアの無料体験・購入・復元・更新・取消・返金・応答喪失、Apple署名JWSの実機取得、RevenueCatのID結合/移転挙動は未検証。商品設定・本番配信・本番デプロイ・認証情報の発行は実施していません。

## 受取Webを同居させる最小構成案

現状はAPIのみで、静的HTML配信・受取画面・独自callback画面はありません。Better Authのmagic-link検証と許可済みcallbackへの302は実装済みです。同じHono Workerに `/receive` と `/invitations` のHTML、および同一オリジンの外部JS/CSSを追加すれば同居できます。`RECIPIENT_WEB_URL` をこのオリジンへ合わせる運用変更が必要です。既存の別オリジンWeb構成は自動で変更しません。

推奨フローは、fragmentをメモリへ取り込みhistory.replaceStateでURLから消す→宛先メールのmagic linkを要求→同じタブで認証状態を再確認する明示ボタン→preview→未選択の死亡確認チェックと開封ボタン→readです。callback URLへ伝言トークンを埋め込まず、別タブでメール認証した場合は元タブへ戻す案が最小です。フルページ再読込時は元の通知リンクからやり直せるよう案内します。

HTML/JSには本文・件名・宛先・秘密URLを埋め込まず、本文はread成功後textContentで描画します。CSPはselfのスクリプトのみ、frame-ancestors none、no-store/no-referrer、外部解析なし。招待承諾と開封同意は別画面/別操作。未確認で終了、辞退、通報を提供し、初期表示・認証callback・GETでreadを呼びません。

この段階では提案のみです。API-014のサーバー試験は済みですが、受取Web画面の操作試験は未実施のため、Pagesで受取Web込みの完了とは扱わないでください。
