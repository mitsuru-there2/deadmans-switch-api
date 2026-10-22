# 配信・ストア連携

本番メールは **Void (`void/email`) → Cloudflare Email Service + React Email**、プッシュは **Expo Push Service** です。サブスクはApp Store / Google PlayのAPIでサーバー検証します。SMSは次期対応です。

## Void / Cloudflare Email / React Email

`src/emails/notice.ts` で日本語の本文をHTMLとプレーンテキストへ変換し、`sendEmail()` に渡します。宛先は常に一件で、伝言の件名・本文・他宛先は含めません。Outbox IDを `idempotencyKey` と `X-Outbox-ID` に渡し、返されたメッセージIDを `void:ID` として保存します。

本番は `NOTIFICATION_DRIVER=native` と `EMAIL_FROM` を設定します。Cloudflareへ直接デプロイする構成なので、`void.config.ts` に実送信元の `email: { from: "表示名 <notice@mail.example.jp>" }` を設定し、同じ値を `EMAIL_FROM` の本番secretへ登録してください。

```sh
bunx void email setup --platform cloudflare
bunx void email status --platform cloudflare
```

任意の利用者・受取人へ送るため、Workers PaidとEmail Sendingのオンボーディング、送信ドメインのSPF／DKIM／DMARCが必要です。確認済み宛先だけへ送る無料枠の設定では、本サービスの一般公開要件を満たしません。実ドメインの設定は未実施です。

ローカルはVoid標準受信箱へキャプチャし、実送信しません。`void/email/testing` の公式ハーネスでも送信を検証しています。従来のgatewayは既存のサービス単体テスト用に維持しています。

Cloudflare Email SendingのEvent Subscriptionを、Voidが作成する `email-events` Queueへ接続してください。対象イベントは `cf.email.sending.message.delivered` と `bounced`／`failed`／`rejected`／`complained` です。`queues/email-events.ts` がメッセージIDを照合し、イベントIDの重複排除と台帳更新をD1の同一バッチで行います。一時的な `deferred` は終端失敗にしません。警告メールの終端失敗では監視・公開を保留します。

Queue consumerは実装済みですが、送信ドメインのEvent Subscription作成は本番設定時に必要です。イベントが送信受付のDB記録より先に来た場合は再試行します。10回の再試行を超えた未処理イベントと、IDを記録できなかった `uncertain` はCloudflare側の活動記録と照合します。イベントのQueueを他用途のproducerへ開放しないでください。

Voidの成功はメール送信受付であり、到達・閲覧とは別です。Cloudflareのnative bindingではVoid Platform側の冪等性保証が適用されないため、Outboxで重複claimを防ぎ、不明な結果を自動再送しません。タイムアウトでメッセージIDを失った通知も手動照合が必要です。

[Voidメール](https://void.cloud/guide/email/sending) / [Cloudflare配信イベント](https://developers.cloudflare.com/email-service/reference/event-subscriptions/) / [React Email](https://react.email/docs/utilities/render)

## Expo Notifications

Expoアプリで権限を確認し、プロジェクトに対応する`ExpoPushToken`を取得して`POST /v1/devices`へ登録します。端末側で通知を表示しただけでは確認APIを呼ばず、本人による明示反応または前面起動時だけ`POST /v1/check-ins`へ送ります。

ExpoのPush Securityを使用する場合は`EXPO_ACCESS_TOKEN`をSecretsへ登録します。APIはExpoの`/push/send`へ送信し、ticket IDを台帳に保存します。Cronが送信15分後以降に`/push/getReceipts`を調べ、`DeviceNotRegistered`なら端末を解除します。ExpoのreceiptはAPNs/FCMへの受け渡し結果であり、本人が通知を見た証明ではありません。receiptは24時間以内に照合してください。

ロック画面には「確認のお願い」「アプリを開いて確認してください。」だけを送り、本文や受信者情報を送りません。

[Expoの送信・ticket・receipt仕様](https://docs.expo.dev/push-notifications/sending-notifications/)

## ストアの商品設定

両ストアで日本だけに販売する**年間・自動更新サブスク**を作成します。基本10宛先、拡張50宛先です。価格設定（企画案: 年980円/1,980円）と商品IDはストア管理画面で決定します。APIで価格・課税・決済画面を生成することはありません。

`STORE_PRODUCTS`に許可した商品だけを列挙します。以下は実際の商品IDへ置き換える例です。

```json
{
  "apple": {
    "jp.example.basic.annual": "basic",
    "jp.example.plus.annual": "plus"
  },
  "google": {
    "basic:annual": "basic",
    "plus:annual": "plus"
  }
}
```

Googleのキーは`productId:basePlanId`です。月額プラン等を同じ商品に作る場合も、年間のbase planだけを許可します。Appleは一つのサブスクリプショングループに基本・拡張商品を置きます。

### クライアントの購入・復元

1. 初回起動で`POST /v1/auth/bootstrap`を自動実行し、端末用トークンを安全に保存します。以後、このBearerトークンで`GET /v1/billing/account`を呼びます。ログイン画面は不要です。
2. 返却されたUUIDの`accountToken`を、Appleでは`appAccountToken`、Googleでは`obfuscatedAccountId`として**購入開始時に**設定します。
3. ストア購入後、`POST /v1/billing/verify`へ次の形式で送ります。同じ端末情報が残る場合の権利再検証も同じAPIです。
4. サーバーがストアへ照会して権利を確定した後、クライアント側の取引完了処理を行います。Googleの未acknowledged購入はサーバーからacknowledgeします。

```json
{ "store": "apple", "transactionId": "2000000123456789" }
```

```json
{ "store": "google", "purchaseToken": "STORE_PURCHASE_TOKEN" }
```

別の端末認証アカウントの`accountToken`が設定された購入、識別子なしの購入、未許可商品、日本以外の購入地域を拒否します。端末用トークンを失った機種変更では、以下の復元専用APIを使います。

`GET /v1/billing/subscriptions`は、検証したストア・商品・状態・契約期限・最終検証時刻を返します。購入トークンは返しません。`/v1/switch`のentitlement期限は安全のため検証から最大24時間に制限した内部有効期限であり、ストア契約そのものの期限は`/v1/billing/subscriptions`で表示します。

### 同じストア内の機種変更

新端末は`POST /v1/auth/bootstrap`で空の端末IDを作り、ストアから取得した購入証明を`POST /v1/auth/restore`へ送ります。通常の機種変更でメールログインは不要です。iPhoneからAndroidなどの移行は対象外です。

- **Apple:** StoreKitの`Transaction.currentEntitlements`等で取得・検証したTransactionの`jwsRepresentation`を`{store:"apple",signedTransaction:...}`として渡します。APIは公式SignedDataVerifierで署名・証明書・アプリ・環境を検証し、`inAppOwnershipType=PURCHASED`を要求します。Family Sharingで他人の伝言は復元できません。署名されたoriginalTransactionIdでストアの現在状態も再照会します。[StoreKitの権利取得](https://developer.apple.com/documentation/storekit/transaction/currententitlements)
- **Google:** `queryPurchasesAsync`で得たpurchaseTokenを`{store:"google",purchaseToken:...}`として渡します。APIは固定packageNameのsubscriptionsv2で有効状態と購入時のアカウント識別子を確認します。トークン変更時はストアが返すlinkedPurchaseTokenを登録済み契約と照合します。[Play Billing連携](https://developer.android.com/google/play/billing/integrate)

**初回購入時の`/v1/billing/verify`成功が前提です。** 認証済みアカウントと購入を結び、`owner_verified_at`を記録します。appAccountTokenはアプリが指定するIDなので、それだけでは本人性を証明しません。未登録の購入やWebhookだけで登録された行を使って既存データへの認証情報は発行しません。`PURCHASE_NOT_REGISTERED`なら元の端末情報か補助のメール復旧で元アカウントへ戻り、購入検証を完了してください。

成功時は元アカウントの新端末トークンを発行し、旧端末トークン・Webセッション・Expo登録を失効させます。クライアントは新端末のExpoトークンを登録し直します。伝言・宛先・同意・設定を保持し、保留状態を自動解除しません。契約失効・返金・削除済みデータは復元対象外です。

購入証明は、この方式でデータの復元を許可する秘密情報です。署名は購入情報の真正性を確認するもので、コピーを持つ第三者まで識別するものではありません。JWS・purchaseTokenをログ、解析SDK、サポートチケット、URLに含めず、TLSと安全な端末ストレージで扱います。APIは購入証明をクライアントへ返しません。

API・HTTP境界のテストとworkerdでの偽造署名拒否を検証しています。実端末2台・実ストアSandboxでの復元、Expo側の購入取得は本番導入前に確認が必要です。

### 初月無料とサブスク必須

初期方針は、対象者に**1か月の無料体験**を提供し、その後は設定した通常の自動更新サブスクへ移行する形です。APIで試用権を無条件に発行しません。無料体験でもストアでの申込みとサーバー検証が必要です。

- **Apple:** App Store Connectで対象商品へ「Free / 1 Month」のIntroductory Offerを設定し、日本向けに公開します。同じsubscription group内での対象可否はStoreKitで取得し、対象外の人に初月無料を約束しません。[公式設定手順](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-introductory-offers-for-auto-renewable-subscriptions)
- **Google:** Play Consoleで対象base planへ新規購読者向けOfferを追加し、無料フェーズを1か月にします。アプリはProductDetailsから現在その利用者に提供可能なofferTokenを選択して購入フローに渡します。[公式設定手順](https://support.google.com/googleplay/android-developer/answer/140504?hl=en)
- 無料終了日・初回請求日・次回価格・自動更新・解約方法をストア情報から表示します。APIで「登録日時＋30日」を無料期間として計算しません。
- **Appleは終了の24時間前までの解約を案内**します。[Appleの解約案内](https://support.apple.com/en-us/118428)
- Googleは無料体験終了前にGoogle Playで解約するよう案内します。アプリ削除や本APIのアカウント削除はストアの解約になりません。[Googleの解約案内](https://support.google.com/googleplay/answer/7018481?hl=ja)
- 解約後もストアが有効と返す期間は利用できます。無料体験の解約でストアが直ちに失効させる場合はそれに従います。更新拒否・返金・失効の後はAPIを拒否し、監視を保留します。

ストア管理画面の設定は未実施です。資格情報・商品が未提供のため、無料体験の適用・解約・初回請求の実ストア検証も未実施です。

### Apple App Store

設定項目:

| 変数                      | 内容                                               |
| ------------------------- | -------------------------------------------------- |
| `APPLE_BUNDLE_ID`         | アプリのBundle ID                                  |
| `APPLE_APP_ID`            | App Store Connectの数値App ID                      |
| `APPLE_ENVIRONMENT`       | 本番は`Production`。開発環境だけ`Sandbox`を許可    |
| `APPLE_ISSUER_ID`         | App Store Connect APIのIssuer ID                   |
| `APPLE_KEY_ID`            | In-App PurchaseキーのID                            |
| `APPLE_PRIVATE_KEY`       | 対応するP8秘密鍵（PEM、改行を保持）                |
| `APPLE_ROOT_CERTIFICATES` | Apple公開ルート証明書のDERをBase64化した配列のJSON |

ルート証明書は[Apple PKI](https://www.apple.com/certificateauthority/)から取得し、発行元・指紋を確認したものを設定します。呼び出し元がJWSに入れた自己署名ルートは信頼しません。

```json
["BASE64_DER_ROOT_CERTIFICATE"]
```

App Store Server Notifications V2のURLは`https://API_DOMAIN/webhooks/apple`です。Apple公式`@apple/app-store-server-library`で通知・取引・更新情報の証明書チェーン、失効検査、署名、アプリID、環境を検証します。Workersではライブラリをリクエスト内で遅延ロードします。

通知を受けた際も`Get All Subscription Statuses`へ照会し直します。古い署名済み更新通知を再送しても、払い戻し済みの権利を復活させません。猶予期限、失効、取消を反映し、日本のストアフロント（`JPN`）だけを許可します。

[Apple公式ライブラリ](https://github.com/apple/app-store-server-library-node) / [Get All Subscription Statuses](https://developer.apple.com/documentation/appstoreserverapi/get-all-subscription-statuses)

### Google Play

設定項目:

| 変数                           | 内容                                                |
| ------------------------------ | --------------------------------------------------- |
| `GOOGLE_PACKAGE_NAME`          | Androidのpackage名                                  |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Play Developer API用サービスアカウント              |
| `GOOGLE_PRIVATE_KEY`           | 対応するRSA秘密鍵（PEM、改行を保持）                |
| `GOOGLE_PUBSUB_AUDIENCE`       | Pub/Sub pushのOIDC audience。通常はWebhookの完全URL |
| `GOOGLE_PUBSUB_EMAIL`          | 認証付きpushに使うサービスアカウントのメール        |

サービスアカウントへPlay Console上で必要なアプリ権限を付与し、Android Publisher APIを有効化します。RTDN用Pub/SubトピックをPlay Consoleに登録し、**認証付きpush**のURLを`https://API_DOMAIN/webhooks/google`にします。

Googleの公開JWKSでBearer OIDCトークンの署名、issuer、audience、`email`、`email_verified`を検証します。RTDNのnotificationTypeだけでは権利を付与せず、サービスアカウントJWTからOAuthトークンを取得し、`purchases.subscriptionsv2.get`へ照会します。package、商品とbase plan、期限、日本地域（`JP`）、アカウント識別子を検証します。本番ではtestPurchaseを拒否します。

解約予約でも残り契約期間が有効な`CANCELED`は期限まで維持します。猶予は`IN_GRACE_PERIOD`、支払保留・一時停止・失効は利用不可として扱います。アップグレード等の`linkedPurchaseToken`は同じアカウントとの関連を確認し、旧権利を終了します。

[Subscriptions V2 Get](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get) / [SubscriptionPurchaseV2](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2) / [Pub/Sub認証](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

### 継続検証

有効契約を6時間ごとに再照会します。Cron一回につき最大10件、古いものから処理します。再検証に失敗した場合は5分後に再試行し、成功確認から24時間を超えると利用権を延長せず監視を保留します。Webhook障害や課金API障害を無反応による公開につなげません。

AppleとGoogleの両方に有効契約がある場合は上位プランを採用します。期限の長い基本プランを理由に、短い拡張プランの期限を延長しません。失効後に復旧しても監視は自動再開せず、本人の再同意が必要です。

実ストアの鍵・商品・Sandbox購入は未提供なので、実サービスへの購入・更新・返金試験は未実施です。実装テストではHTTP応答とストア検証の境界を差し替え、権利判定・紐付け・署名拒否・acknowledgeを確認しています。公開前に両ストアのテスト環境で購入・復元・猶予・失効・返金を確認してください。

## 次期フェーズ: SMS

SMS対応は次期フェーズで検討します。事業者選定、電話番号の所有確認、受取同意、料金・文字分割数の上限、配信結果の照合を設計した上で実装します。初期フェーズでは設定を追加してもSMS送信は有効になりません。

既存DBのSMSレコードは保持しますが、監視の有効化・SMS招待の承諾を拒否し、公開生成時も保留します。未送信のSMS Outboxは配信処理で取り消します。メールへ自動変換しないため、利用者は宛先をメールとして登録し直して承諾を得る必要があります。

`NOTIFICATION_GATEWAY_URL`と`NOTIFICATION_GATEWAY_SECRET`はローカルのメール・プッシュ通知キャプチャ用です。通常のVoidローカル開発と本番配信では不要です。

外部送信のタイムアウト・結果不明はuncertainです。受け付けた可能性があるため自動再送しません。台帳がsendingで2分経過した場合も同様です。事業者の受付記録を調べて結果を確定してください。未確定通知の再送APIはありません。

## 正規化した配信結果・開発用権利イベント

`POST /webhooks/events`はローカル検証など、信頼できるサーバーからの正規化済みイベント用です。本番のメール配信結果はCloudflare Queues経由で受け取ります。

- `X-Timestamp`: UTC Unixミリ秒、±5分
- `X-Signature`: `HMAC-SHA256(WEBHOOK_SECRET, timestamp + "." + rawBody)`のBase64
- `id`: 固定の一意イベントID。再送で変更しない

```json
{
  "id": "local-delivery-event-456",
  "type": "delivery",
  "outboxId": "OUTBOX_UUID",
  "state": "delivered",
  "providerId": "provider-message-id"
}
```

`state`はaccepted、delivered、failedです。イベント重複排除と状態変更は同じトランザクションで実行します。

開発環境だけ、次の形式のテスト権利を受け付けます。本番では`STORE_VERIFICATION_REQUIRED`で拒否します。`bun run local grant USER_ID`はこの形式をlocalhostへ送ります。

```json
{
  "id": "local-event-1",
  "type": "entitlement",
  "userId": "USER_ID",
  "plan": "basic",
  "status": "active",
  "validUntil": 1823382000000,
  "sourceVersion": 1
}
```
