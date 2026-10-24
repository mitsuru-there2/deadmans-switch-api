# API仕様

機械可読仕様は`GET /openapi.json`です。入力JSON Schemaは実際のZod検証と共有しています。日時はUTCのUnixミリ秒、画面表示は`Asia/Tokyo`を想定します。`day`は24時間で、暦日の切り替わりではありません。

## 認証と共通事項

本人はアプリが自動取得した端末用トークンで認証します。通常のログイン画面は不要です。初回は`POST /v1/auth/bootstrap`へ空のJSON `{}` を送ります。`201`の応答は`{token,expiresAt,accountToken,userId}`です。`token`をExpo SecureStoreに保存し、以後`Authorization: Bearer TOKEN`を送ります。購入前には主要APIを利用できません。

| Method / Path                     | 入力・動作                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/bootstrap`         | 認証不要。`{}`。購入用の識別子と端末用トークンを作成。IPごと10回/時                                       |
| `POST /v1/auth/device-session`    | 端末トークンを更新、または確認済みメールの復旧セッションから交換。`{token,expiresAt}`                     |
| `DELETE /v1/auth/device-sessions` | 本人の全端末用トークンを失効。204                                                                         |
| `POST /v1/auth/restore`           | 新端末のBearerトークン＋購入証明。元の`{token,expiresAt,accountToken,userId}`を返す                       |
| `POST /v1/auth/restore/result`    | 元fresh Bearer＋operationSecret。15分以内の復元結果だけを再取得。詳細は[契約](restore-result-recovery.md) |
| `POST /v1/contact-email`          | `email,name`。サブスク必須。警告・復旧先の確認メールを送信、3回/日、202                                   |
| `POST /v1/contact-email/confirm`  | `token`。登録を始めた端末の認証情報も必須。`{verified:true}`                                              |

端末トークンは180日有効です。有効期限内に`device-session`を自動実行して新しいトークンを保存してください。更新は直列に行い、並行したAPIリクエストは保存後のトークンを使います。旧トークンは直ちに失効します。更新応答を失った場合や端末の認証情報が失われた場合は、同じストアの購入を復元します。トークンはURL・ログ・通常のAsyncStorageへ保存しません。トークン更新・購入検証・バックグラウンド通信は本人確認の記録には数えません。

連絡先確認URLは`RECIPIENT_WEB_URL/confirm-contact#TOKEN`です。登録を始めたアプリでフラグメントを読み、端末認証付きで確認APIへ渡します。10分・単回利用で、再発行時は旧リンクが失効します。メール確認では他アカウントへの統合はしません。既存アカウントに結び付いたメールは`EMAIL_ALREADY_LINKED_USE_RECOVERY`となり、そのメールで元のアカウントへ復旧します。確認済みメールの変更には後述の専用APIを利用します。

**同じストア内の機種変更・再インストール**では、新端末でbootstrapを実行し、そのBearerトークンで`POST /v1/auth/restore`を呼びます。Appleは`{store:"apple",signedTransaction:"STOREKIT_TRANSACTION_JWS"}`、Googleは`{store:"google",purchaseToken:"GOOGLE_PURCHASE_TOKEN"}`です。元のアカウントに認証付きで登録済みの購入と、ストアで確認した現在の有効な契約を照合します。復元先IDは入力で受け取りません。AppleのtransactionIdだけの要求は400、未登録の契約・契約失効は403です。端末IDごと5回/分、IPごと10回/分に制限します。

成功時に返る新トークンをSecureStoreへ保存します。空のbootstrapアカウントを削除し、元アカウントの旧端末トークン・Better Authセッション・Expo登録を失効させます。新端末はExpoトークンを登録し直してください。メール、宛先、本文、設定、本人確認の時刻、監視状態は保持します。復元自体は本人確認や監視再開には数えません。アプリが前面にあるときだけ`/v1/check-ins`を明示的に呼びます。

既に別アカウントの設定・契約を持つ端末からの復元は`409 RESTORE_REQUIRES_FRESH_DEVICE_IDENTITY`です。アカウント統合・ストアをまたぐ移行は提供しません。同じ復元要求の再送では旧bootstrapトークンが失効しているため401になります。応答を失った場合は新しくbootstrapして購入を復元してください。削除済みアカウントのデータは復元しません。

確認済みメールの復旧リンクも補助的に利用できます。`POST /api/auth/sign-in/magic-link`へ元メールと許可済み`callbackURL`を送り、Better Authの10分・単回リンクを検証します。`set-auth-token`のセッションで`POST /v1/auth/device-session`を呼ぶと新しい端末トークンへ交換します。同じストアの購入が復元できる場合、この操作は不要です。

受信者はBetter Authの同じメールリンクで認証します。ブラウザはCookie＋`credentials:include`、ネイティブはBearerセッションです。受信者の契約は不要です。`/api/auth/get-session`、`/sign-out`、`/list-sessions`、`/revoke-session`、`/revoke-other-sessions`はBetter Authのセッション用です。端末用トークンの取消には上記の`DELETE /v1/auth/device-sessions`を使います。パスワード認証は無効です。

ExpoのUniversal Links / App Linksを`TRUSTED_ORIGINS`へ設定します。任意のカスタムスキームを本番設定へ追加する実装にはしていません。

有効なサブスク（無料体験・ストアの有効な猶予期間を含む）がなければ主要APIは`403 SUBSCRIPTION_REQUIRED`になります。例外は購入・復旧・認証管理、`GET /v1/me`、`DELETE /v1/me`、`GET /v1/export`、`POST /v1/switch/pause`、連絡先の確認完了、および受信者用APIです。契約なしで宛先・伝言の下書きを作ることもできません。無料体験中の解約だけで直ちに失効させず、ストアが返す有効状態・期限を適用します。

本人用APIはユーザーIDを入力で受け取りません。所有権をセッションから決定します。受信者のAPIは、登録された受信者メールとログイン済みメールの一致を毎回検証します。

エラー形式は`{"error":{"code":"VERSION_CONFLICT"}}`です。主なHTTPステータスは400（入力）、401（認証）、403（国・Origin・サブスク必須・確認済みメール必須）、404（不存在・他人のデータ）、409（状態・バージョン競合）、422（有効化の前提不足・上限）、429（頻度）、503（設定・DB・監視状態）です。Better Authのエラー形式は同ライブラリに従います。

所有者のリクエストは120回/分。招待は10回/日/本人、同一宛先には1日1回、自分宛テストは3回/日です。登録可能宛先を無制限に作り直して外部通知を送ることを抑制します。制限はDBへ保存するためWorkerの再起動でリセットされません。入出力に本文・トークンを記録するHTTPロガーは使っていません。

## 確認済みメール変更（2026-10-24追加）

開始端末の有効なdevice Bearerが必須です。契約失効後も利用できます。旧メールが利用できない場合の変更・アカウント統合・ストア横断移行は提供しません。

| Method / Path                         | 入力・成功応答                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST /v1/contact-email/change         | `{email,confirmed:true}` → 202 `{changeId,step:"verify_old",expiresAt}`                               |
| GET /v1/contact-email/change          | `{change:null}` または `{change:{id,email,step,expiresAt}}`。開始端末分のみ                           |
| POST /v1/contact-email/change/confirm | `{token}`。旧メール確認後は200 `{step:"verify_new",expiresAt}`、新メール確認後は200 `{verified:true}` |
| DELETE /v1/contact-email/change       | 204。取消後も監視は停止したまま                                                                       |

開始時に監視をpausedにし、公開リンクと未送信の警告・プッシュ・最終通知を失効させます。確認中は`EMAIL_CHANGE_PENDING`で有効化を拒否します。旧メールの所有確認を直近の本人再認証とし、それに成功してから新メールへ確認リンクを送ります。リンクは`RECIPIENT_WEB_URL/confirm-contact-change#TOKEN`。開始端末がフラグメントを読み、JSONでconfirmへ送ります。GETだけでは確認しません。期限は開始から10分で延長せず、各リンクは単回利用です。開始要求は3回/日で、進行中・不正要求もカウントします。

変更完了はメール更新・認証世代更新・全Better Authセッションと他端末資格情報/プッシュ登録の失効をD1の同一バッチで確定します。旧メールで発行済みの復旧リンクや、変更と競合して作成された旧世代セッションは元アカウントを復旧できません。開始端末のBearerは維持します。旧・新メールへ完了通知を送り、新メールでself-testがaccepted/deliveredになるまで`SELF_TEST_REQUIRED`を返します。完了・取消・期限切れでも監視は自動再開しません。

主なエラー: 400 `INVALID_EMAIL_CHANGE_LINK`、401 `DEVICE_AUTHENTICATION_REQUIRED`、403 `VERIFIED_EMAIL_REQUIRED`/`EMAIL_CHANGE_DEVICE_REQUIRED`、409 `EMAIL_CHANGE_IN_PROGRESS`/`EMAIL_UNCHANGED`/`EMAIL_ALREADY_LINKED_USE_RECOVERY`/`EMAIL_CHANGE_INVALIDATED`、429 `RATE_LIMITED`。タイムアウト後はGETとmeを照合し、開始・確認を無条件再送しません。

## 登録端末の追加情報（2026-10-24）

`POST /v1/devices`は従来の`token`に、任意の`name`（trim後1〜100文字）と`platform:"ios"|"android"`を受け付けます。省略したメタデータは既存値を保持します。現在端末のプッシュトークン更新でもIDを維持し、旧トークン向け未送信通知を取り消します。

`GET /v1/devices`は`{devices:[{id,createdAt,name,platform,lastSeenAt,isCurrent}]}`を登録日時降順で返します。lastSeenAtは対応する端末資格情報で最後に認証が成功したサーバー時刻（Unix ms）です。現在端末はBearer文字列ではなく内部資格情報IDで判定するため、Bearer更新後も一致します。旧登録の不明項目はnull、紐付けのない登録はisCurrent:falseです。トークン・内部資格情報IDは公開しません。端末一覧はCookieだけでは利用できません。

## 本人用

| Method / Path                       | 入力・動作                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /v1/me`                        | `user:{id,email,emailVerified}`と`switch`。メール未確認ならemailはnull                    |
| `GET /v1/switch`                    | 状態、version、最終確認、期限、契約、同意版                                               |
| `PATCH /v1/switch`                  | `version,inactivityDays,graceDays`。下書き・停止・保留中のみ                              |
| `POST /v1/switch/activate`          | `version,confirmed:true,consentVersion`。正常な監視・契約・承諾・本文・自分宛テストを検査 |
| `POST /v1/switch/pause`             | 停止。古いversionを必要とせず常に停止を優先                                               |
| `POST /v1/check-ins`                | `kind:"foreground"`または`"notification_action"`                                          |
| `GET /v1/recipients`                | `{recipients:[...]}`。本人分のみ復号                                                      |
| `POST /v1/recipients`               | `version,name,channel:"email",email`。戻り値`id,version,status`                           |
| `DELETE /v1/recipients/:id`         | `version`。宛先と本文・関連公開を削除                                                     |
| `POST /v1/recipients/:id/invite`    | メールで受取承諾を依頼。202はキュー登録                                                   |
| `GET /v1/messages`                  | `{messages:[{id,recipientId,title,body,revision,updatedAt}]}`                             |
| `PUT /v1/recipients/:id/message`    | `version,title,body`。1宛先1本文。新規も更新も同じ経路                                    |
| `DELETE /v1/recipients/:id/message` | `version`                                                                                 |
| `GET /v1/devices`                   | 本人の端末ID・登録日時・端末名・OS・最終API利用時刻・現在端末判定                         |
| `POST /v1/devices`                  | `token:ExpoPushToken[...]`。最大5端末。既存は同じID                                       |
| `DELETE /v1/devices/:id`            | 本人端末だけ削除。未送信プッシュも無効になる                                              |
| `POST /v1/self-test`                | 本人の確認済みメールだけへ固定テスト通知。202                                             |
| `GET /v1/deliveries`                | 最新200件のID、宛先ID、通知種別、配信状態、作成日時。秘密URLは返さない                    |
| `GET /v1/audit`                     | 最新200件の状態変更履歴。本文・宛先・IPを含めない                                         |
| `GET /v1/export`                    | 本人の状態・宛先・本文のJSON添付。認証情報は含めない                                      |
| `DELETE /v1/me`                     | `confirmation:"DELETE"`。セッションを含む関連データを削除。204                            |

編集系は`version`を楽観ロックとして使います。変更・承諾・確認の後は再取得してください。古い画面からの有効化を拒否し、監視中の本文・宛先変更を禁止します。宛先を変更する場合は停止→旧宛先削除→新宛先作成→再承諾→再有効化です。初期フェーズの宛先はメールのみです。`channel:"sms"`や`phone`を含む登録要求は400で拒否します。未契約では作成・編集・主要な閲覧はできません。

有効化例:

```json
{ "version": 5, "confirmed": true, "consentVersion": "2026-10-14-v2" }
```

状態応答の主なフィールド:

```json
{
  "state": "active",
  "version": 6,
  "inactivityDays": 30,
  "graceDays": 7,
  "lastCheckInAt": 1791846000000,
  "confirmationDueAt": 1794438000000,
  "earliestReleaseAt": null,
  "holdReason": null,
  "consentVersion": "2026-10-14-v2"
}
```

`earliestReleaseAt`はメール警告が受け付けられるまでnullです。通知への反応・前面起動でも、サーバーが成功を返すまでは確認済みに表示しないでください。クライアントはバックグラウンド通信から確認APIを呼びません。サーバーは申告されたイベントの種別を検証できますが、OS上の前面状態や本人の生体認証の実施は証明できません。

## 受信者用

招待URLは`RECIPIENT_WEB_URL/invitations#TOKEN`、最終通知URLは`RECIPIENT_WEB_URL/receive#TOKEN`です。フラグメントをWebクライアントで読み、APIのJSON本文へ渡します。フロントエンドはログインを挟んでフラグメントを安全に保持し、解析・Referer・サーバーログへ流さないでください。同じHonoで`/invitations`・`/receive`・`/recipient-auth`を配信します。同居構成ではRECIPIENT_WEB_URLをAPIと同じオリジンに設定してください。トークンはメモリだけに保持し、再読込時は最初の通知リンクからやり直します。

| Method / Path                              | JSON入力                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `POST /v1/invitations/preview`             | `token`。一致するメールの受信者に送信者名・宛先ID・チャネル・招待期限を返す                           |
| `POST /v1/invitations/respond`             | `token,action:"accept"/"decline"/"report"`。招待は7日有効・一回限り                                   |
| `POST /v1/recipient-consents/:id/withdraw` | `action:"decline"/"report"`。承諾後、最終通知前でも辞退できる                                         |
| `POST /v1/received`                        | `token,action:"preview"/"read"/"decline"/"report"`。readには`deathConfirmed:true,noticeVersion`が必須 |

受取承諾は招待先メールの認証で行います。SMS・電話番号の受付は対応対象外です。

開封前は`{token,action:"preview"}`で`{senderName,notice,noticeVersion,expiresAt}`のみ取得します。件名・本文・抜粋は含まれず、同意も記録されません。注意文を表示し、受取人が別手段で死亡を確認したと明示操作したときだけ`{token,action:"read",deathConfirmed:true,noticeVersion:"2026-10-14-v1"}`を送ります。事前の受取承諾とこの開封同意は別です。

`action`省略、同意欠落/false、未定義入力は`400 INVALID_REQUEST`、旧注意文版は`422 OPENING_NOTICE_VERSION_REQUIRED`。GETや認証完了で開示しません。各readで明示同意が必要で、過去の同意は失効を迂回しません。同意は認証済み受取人・公開イベント・宛先・固定本文版・注意文版とサーバー時刻に紐付けます。移行前の固定本文はrevisionがnullですが、暗号化スナップショットのハッシュで識別します。

停止・チェックイン・辞退と開封はimmediateトランザクションで直列化します。先にコミットした停止は開示を拒否します。開封が先にコミットした場合の取得済み内容は回収できません。受取Webは本文を先読みせず、フラグメントのトークンをログ・解析へ出さないでください。

閲覧成功は`{"message":{"title":"...","body":"..."},"expiresAt":...}`です。トークンだけ・別人のメール・期限切れ・停止済み・拒否済みでは閲覧できません。同意撤回時は所有者の監視を保留します。公開後の拒否・通報は当該受信者の閲覧・未送信通知を失効します。本文の理解や対応を保証する閲覧証明ではありません。

## サブスクリプション

- `GET /v1/billing/account`: 購入に設定する`accountToken`と商品一覧
- `GET /v1/billing/subscriptions`: 検証済みのストア・商品・契約期限・状態・検証時刻。購入トークンは返さない
- `POST /v1/billing/verify`: Appleは`store:"apple",transactionId`、Googleは`store:"google",purchaseToken`。購入・復元をサーバー検証

購入開始時に`accountToken`をAppleのappAccountToken / GoogleのobfuscatedAccountIdへ渡します。サーバーはストアが返すアカウント識別子を端末認証済みアカウントと照合します。購入検証は10回/分/利用者です。ストアの契約期限と、安全のため24時間以内に再検証する内部entitlement期限を画面で混同しないでください。

## 運用・Webhook

- `GET /health/live`: プロセス応答
- `GET /health/ready`: DBへの実接続。自動で監視正常とは扱わない
- `POST /internal/probe`: 独立した外部監視が1分ごとに呼ぶ確認APIプローブ
- `POST /internal/tick`: 手動Cron＋Outbox処理
- `POST /internal/recover`: 運用障害フラグを解除。本人監視は保留のまま
- `GET /internal/status`: ジョブの状態、監視時刻、保留すべき未確定・失敗通知

`/internal/*`は`Authorization: Bearer OPERATIONS_SECRET`です。利用者のセッションでは呼べません。`/webhooks/events`の署名と契約は[接続仕様](integrations.md)を参照してください。

メールの配信結果はCloudflare Email SendingのEvent SubscriptionからVoid Queueへ入り、HTTPのResend webhookは廃止しました。`POST /webhooks/apple`はApple署名JWS、`POST /webhooks/google`はGoogle OIDCを検証します。詳細な商品・鍵・通知設定は[配信・ストア連携](integrations.md)にあります。

## アプリ向けの共有応答と同意本文

全 `/v1` JSON成功応答のschemaはOpenAPIと`src/responses.ts`で共有し、Hono Clientは`deadmans-switch-api/client`から利用できます。接続例・互換追加・購入接続の未解決点は[アプリ契約](app-contract.md)を参照してください。

`GET /v1/consents/current`は認証必須、購入前でも利用可能で`{version,language,effectiveAt,title,body}`を返します。取得した所有者説明文を表示し、明示同意の際にversionをactivateのconsentVersionとして送ってください。受取開封のnoticeVersionとは別です。

監視のGET応答にはserverTimeとactivationBlockersを追加しました。blockersは表示補助であり、有効化時には最新状態を再検査します。宛先のGETにはinvitationExpiresAt/nextInvitationAt、自分宛テストの202にはdeliveryIdを含めます。テストのdeliveryIdを配信台帳で追跡し、accepted/deliveredまで合格にしません。
