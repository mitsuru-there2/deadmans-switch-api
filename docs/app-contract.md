# アプリ実装への引き継ぎ（2026-10-24）

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

## RevenueCat と既存ストア検証を接続する最小構成

権利の正は引き続きストアを直接再検証する API です。CustomerInfo、RevenueCat appUserID、注文番号だけで権利付与・復旧しません。新認証方式・本番設定は追加していません。

アプリに入っている `react-native-purchases 10.13.0` の型と依存を確認しました。MakePurchaseResult.transaction の `transactionIdentifier` は両OS、`purchaseToken` はAndroid用（null許容）です。`restorePurchases()` は CustomerInfo のみで、Apple署名JWSを返しません。依存は PurchasesHybridCommon 19.11.0 → iOS 5.95.0 / Android 10.27.0 です。iOS版は UUID の appUserID を StoreKit 2 の appAccountToken に設定し、Android版は SHA-256(appUserID) を obfuscatedAccountId に設定します。Androidの置換購入では設定を省略する場合があり、実ストアの応答に所有者識別子がない場合は API が拒否します。危険なSDK設定で回避しません。

参照: [固定iOS実装](https://github.com/RevenueCat/purchases-ios/blob/5.95.0/Sources/Purchasing/Purchases/PurchasesOrchestrator.swift)、[固定Android実装](https://github.com/RevenueCat/purchases-android/blob/10.27.0/purchases/src/main/kotlin/com/revenuecat/purchases/google/BillingWrapper.kt)、[SHA-256符号化](https://github.com/RevenueCat/purchases-android/blob/10.27.0/purchases/src/main/kotlin/com/revenuecat/purchases/common/utils.kt)、[依存iOS版](https://github.com/RevenueCat/purchases-hybrid-common/blob/19.11.0/PurchasesHybridCommon.podspec)、[依存Android版](https://github.com/RevenueCat/purchases-hybrid-common/blob/19.11.0/android/gradle/libs.versions.toml)、[SDK型](https://github.com/RevenueCat/purchases-hybrid-common/blob/19.11.0/typescript/src/customerInfo.ts)。ネイティブのロックファイルで実際の解決版を確認し、更新時は再確認してください。

### 通常購入

1. API bootstrap で得た `accountToken`（プロフィールUUID）をそのまま RevenueCat の `appUserID` に設定。事前ハッシュ化しません。
2. RevenueCat で購入。保留・取消は購入成功として扱いません。
3. iOS は transaction.transactionIdentifier を `{store:'apple',transactionId}`、Android は実際の transaction.purchaseToken を `{store:'google',purchaseToken}` として `POST /v1/billing/verify` へ本人Bearer付きで送ります。Androidのtokenがnullなら後述のネイティブ照会で取得します。注文番号の代用は禁止です。
4. API成功後に `GET /v1/me` / `GET /v1/billing/subscriptions` を再取得。verify は通常 entitlement を返しますが、遅延応答が最新検証に追い越された場合は `{received:true}` です。いずれも現状態の再取得が必要です。

Google は本人の profile UUID と、その UTF-8 SHA-256 を標準Base64（paddingあり・改行なし）に符号化した値だけを一致対象とします。APIがストアから得た識別子をサーバー計算で照合し、DBには元のUUIDで正規化します。購入時の照合はacknowledge前にも行います。Webhookは既に登録した現在/linked purchase referenceから所有者を得て同じ照合をします。未知のハッシュからプロフィールを探索せず403にし、最初の本人によるverifyを待ちます。既存の直接UUID形式は互換維持、Appleにはハッシュを許可しません。Webhook単独ではownerVerifiedAtを立てません。

### 同一ストア復旧

新規bootstrapのBearerを保持し、利用者が復旧を選んだときにOSから証明を取得します。復旧対象は元のアカウントなので、その証明の所有者を新bootstrapのaccountTokenと比較して除外しません。

- iOS: 明示的な復旧操作でだけ `AppStore.sync()`、次に `Transaction.currentEntitlements` の verified 結果から対象商品の自動更新購読・本人購入を選び、その **VerificationResult.jwsRepresentation全体** を取得。`POST /v1/auth/restore` に `{store:'apple',signedTransaction}` を送信。transactionIdだけでは復旧不可。
- Android: BillingClient の `queryPurchasesAsync(SUBS)` で PURCHASED の対象購読を照会し、`Purchase.purchaseToken` を取得。同APIに `{store:'google',purchaseToken}` を送信。現在の権利・商品・地域・所有者はAPIがGoogleへ再照会します。
- APIは登録済み購入reference/linked reference、過去の本人購入検証、現在のストア検証、所有者の一致を必須とします。ハッシュ形式でも条件は同じです。未登録や複数の別所有者を結合しません。
- API成功後、返されたtokenをSecureStoreに保存し、返された元のaccountTokenにRevenueCatを合わせ、通知を再登録します。復旧前に新IDでRevenueCat restore/logInを実行して購入移転を起こす経路は避けます。RevenueCatの移転設定は未決定です。
- 複数アカウントに対応する購入候補がある場合は自動的にマージ・順次復旧しません。候補選択の設計が必要です。復旧は旧端末認証・既存セッション・Expo登録を失効させますが、チェックインや監視再開は行いません。

### アプリ側に必要な小さなネイティブモジュール

APIリポジトリにはネイティブコードを追加しません。アプリ側の候補構成は `modules/store-proof/index.ts`、`ios/StoreProofModule.swift`、`android/.../StoreProofModule.kt`、`expo-module.config.json` です。

```ts
type AppleProof = { productId: string; transactionId: string; signedTransaction: string };
type GoogleProof = { productIds: string[]; purchaseToken: string };
// sync=true は利用者が明示的に復旧を要求した場合だけ
getAppleProofs(options: { sync: boolean }): Promise<AppleProof[]>;
getGoogleProofs(): Promise<GoogleProof[]>;
```

iOSは未検証/家族共有/失効を候補から除外し、JWSをそのまま返します。Androidは接続・結果・終了を管理し、保留購入を候補に含めません。ブリッジは証明読取だけに限定し、独自のpurchase/finish/consume/acknowledgeを加えてSDKと競合させません。証明はログ・SQLite・分析に記録せず、APIへ送信する間だけメモリ保持。Expo Goではなくネイティブビルドが必要です。

OS資料: [Apple currentEntitlements](https://developer.apple.com/documentation/storekit/transaction/currententitlements)、[Apple JWS](https://developer.apple.com/documentation/storekit/verificationresult/jwsrepresentation)、[Apple sync](<https://developer.apple.com/documentation/storekit/appstore/sync()>)、[Play Billing照会](https://developer.android.com/google/play/billing/integrate)、[Purchase token](<https://developer.android.com/reference/com/android/billingclient/api/Purchase#getPurchaseToken()>)。

実機の証明取得・署名・無料体験・購入・復旧・更新・返金・応答喪失、SDKのID移転/alias、置換購入でのaccount識別子は未検証です。本番配信、ストア設定、認証情報発行は未実施です。RevenueCat Webhookの接続案は別文書に残し、公開ルートや権利更新元には採用していません。

## 最新 Page との差分と未確定契約

- **API-021 実装**: GET /v1/devicesへname/platform/lastSeenAt/isCurrentを追加。POSTのname/platformは任意。トークン更新後も現在端末を識別し、プッシュトークン更新でも登録IDを維持します。詳細は[API仕様](api.md)。
- **API-022 実装**: 旧・新メール確認による変更APIを追加。開始時停止、10分・単回リンク、開始端末必須、変更後の新メール宛self-testと明示再開が必要です。アプリ画面とリンク受け取りの接続は別途必要です。
- **API-023 SMS / API-024 ストア横断移行**: 対応対象外です。

- **API-019 保留**: 汎用冪等性契約（キー保持期限・範囲・再送応答）は未確定。既存version照合と状態再取得を継続します。
- API-023 SMS / API-024 異ストア復旧は対応対象外です。

## 同居する受取Web

`/receive`・`/invitations`・`/recipient-auth`を同じHonoに実装しました。メール認証後に本文なしpreviewを取得し、受取人のチェックと開封操作でだけreadします。フラグメントは直ちに消し、トークンはメモリのみ。再読込・ページを戻る場合は元リンクからやり直します。タブを隠すと本文とチェックを消去し、遅延応答も破棄します。

配信するJavaScriptのイベントをDOMモックで実行し、実際のBetter Authメール認証・APIと組み合わせた試験、および専用ローカルサーバーへの実HTTP試験を実施しました。この環境には操作可能なブラウザーがなく、スクリーンショット・実ブラウザー描画・実端末アクセシビリティ確認は未実施です。手順は[受取Web](recipient-web.md)。

RevenueCatのサーバー橋渡しについて追加調査とモック実装を[接続案](revenuecat-bridge.md)に記載しました。公開ルート・購入権利・復旧経路は変更していません。

## 独立レビュー修正（2026-10-14）

受取APIのpreview/readは、公開済みstateだけでは許可しません。所有者の内部entitlement失効・配信停止スイッチ・監視tick/probeの5分超過・incidentをCron実行前にも検査し、404で拒否します。本文復号後に期限を迎えた場合も同意記録を残さず拒否します。辞退/通報は継続可能です。監視状態のheld遷移と永続的なリンク失効は従来どおりCronが行います。実ブラウザ確認は未実施です。

Google置換購入は `store_subscriptions.linked_reference_hash` にストア再検証で得た置換元を保存します。復旧は現在購入から保存済みの鎖を辿り、同一ストア・同一所有者の過去の本人購入登録を必須とします。WebhookでB→A、C→Bを検証した場合、本人登録済みAまでCから辿れます。Webhook自体はownerVerifiedAtを設定しません。復旧証明と鎖を検証した復旧処理だけが、従来どおり現在購入へ確認済みの印を記録します。循環・参照変更・異所有者/異ストア・未登録の途中購入・本人登録のない鎖は拒否し、探索は最大256件で打ち切ります。

migration `0007_white_prism.sql` はnullable列の追加だけで、過去の置換関係を推測して埋めません。旧DBの途中購入に関係が残っていない場合は復旧を拒否します。その中間購入をサーバーの既存ストア検証で再照会し、ストアから置換元を再取得できれば鎖が補完されます。再取得できない関係をクライアント申告や同じaccountTokenだけで補いません。今回migrationはメモリ内テストDBだけに適用し、稼働DBや本番の再検証・復旧は実施していません。

## 復元応答喪失の救済

任意の `operationSecret` をPOST /v1/auth/restoreに追加し、元fresh Bearerと同じ秘密による `POST /v1/auth/restore/result` で成功結果を最大15分再取得できます。新しい認証の再発行は行わず、更新/失効した結果は返しません。アプリ側の保存順序、pending/failed/404、放棄時のfresh Bearer失効、保持期限と脅威は[復元結果の再取得契約](restore-result-recovery.md)を参照してください。アプリmain59a6a1b自体には未接続です。
