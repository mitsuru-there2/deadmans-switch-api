# 私に何かあったら API

一定期間の本人確認がなく、メールによる警告と猶予期間を経過したとき、宛先ごとの伝言の閲覧入口を通知するAPIです。死亡判定は行いません。

Void 1.2.1 / Cloudflare Workers / D1 (SQLite) / Drizzle ORM / Hono / Better Auth / Bun。メールは `void/email` のCloudflare送信とReact Email、プッシュはExpo、課金はApp Store / Google Playを利用します。API・DB・定期実行・メールの開発とデプロイはVoidへ統一しています。

## ローカルで起動する

Bun 1.3.14と、Void同梱のVite／workerdを実行できるNode.jsが必要です。

```sh
bun install --frozen-lockfile
bun run setup:local
bun run prepare
bun run db:migrate
bun run dev
```

APIと受取Webは `http://localhost:8787`。D1はVoidがローカルで管理し、Dockerや別DBサーバーは不要です。環境変数はルートの `.env` に保存します。既存のローカル秘密値は移行時に引き継ぎ、旧ファイルは `.local/legacy-dev.vars` に保管しています。新しいcloneでは `setup:local` が開発専用の値を生成します。

`void/email` は開発中のメールを外部送信せず、起動ログに表示するVoid受信箱へ保存します。認証リンクを含むため、受信箱のトークンと `.env` は共有しないでください。Cronはローカルで自動実行されません。Outboxの処理は次で進めます。

```sh
bun run local tick
bun run check        # 型・Lint・Format・サービス/APIテスト
bun run build        # Voidの本番バンドル生成
bun run test:e2e     # 一時D1・実HTTPで全公開API契約を検証（外部事業者のみ代替）
bun run test:runtime # 一時D1とVoid実workerdでメール確認・復旧・削除を検証
```

`test:e2e` の実行範囲・隔離・外部代替は[実D1 E2E](docs/e2e.md)を参照してください。確認済みメール変更と端末一覧の追加情報は[API仕様](docs/api.md)にあります。

`test:runtime` はローカルサーバーを一時起動し、React EmailのレンダリングとApple偽造署名の拒否も確認します。`bun run test:smoke` は起動済みの開発サーバーへ同じAPIフローを実行します。停止はCtrl+C。DBは保持されます。

## リポジトリ限定のVoidスキル

公式 `bunx void init` で `AGENTS.md` と `.agents/skills/void`、`.agents/skills/migrate-vite-cloudflare-to-void` を導入しました。スキルはこのリポジトリの `node_modules/void/skills/` への相対リンクです。グローバルのスキル設定は変更していません。手順はインストール済みの `node_modules/void/docs/` を参照します。

## ログイン操作なしの利用開始

本人アプリに通常の登録・ログイン画面は不要です。初回に`POST /v1/auth/bootstrap`を自動実行し、返却された端末用トークンをExpo SecureStoreへ保存します。この段階では購入・復旧の準備だけができ、伝言の作成・閲覧等はできません。

1. アプリが取得した`accountToken`をAppleの`appAccountToken` / Googleの`obfuscatedAccountId`として購入に設定します。
2. ストアでサブスク（対象者は初月無料体験）を申し込み、`POST /v1/billing/verify`へ購入情報を送ります。
3. サーバーがApple/Googleで検証した有効な利用権がある間、`Authorization: Bearer DEVICE_TOKEN`で主要APIを利用できます。毎回のメールログインは不要です。
4. 警告の連絡先として、本人メールを`POST /v1/contact-email`で登録・確認します。これは連絡先の確認で、通常利用のログイン操作ではありません。監視の有効化には確認済みメールが必要です。

購入番号や`accountToken`自体をAPI認証の秘密鍵にはしません。端末用トークンはDBにハッシュのみ保存し、180日以内に自動更新できます。**同じストア内の機種変更・再インストールは購入の復元で引き継ぎます。** 新端末のbootstrapトークンと購入証明を`POST /v1/auth/restore`へ送り、ストアの現在状態と登録済み契約の一致を検証後、元の伝言・設定を使える端末トークンを受け取ります。メール操作は不要です。旧端末の認証・プッシュ登録は失効します。Appleは署名付きTransactionのJWS全体、GoogleはpurchaseTokenを使い、購入番号だけでは復元できません。ストアをまたぐ移行は対象外です。メールによる復旧は補助経路として残します。

**サブスク必須**です。無料体験も有効なストア契約として扱います。契約失効時は主要APIを`403 SUBSCRIPTION_REQUIRED`で拒否し、監視も保留します。購入・復旧・契約状態の確認、監視停止、書き出し、アカウント削除は引き続き可能です。受信者にはサブスクを求めず、Better Authのメールリンクで受取承諾・閲覧を認証します。

**初月無料はストア側の設定が必要**です。AppleはIntroductory Offer、GoogleはSubscription Offerに1か月の無料体験を設定します。対象者・無料終了日時・更新価格はストア情報を表示し、APIで独自に30日を加算しません。無料体験の対象外の利用者もいます。Appleでは無料体験終了の24時間前までの解約が案内されているため、「無料期間中ならいつでも課金なし」とは表示しません。設定と解約条件は[配信・ストア連携](docs/integrations.md)を参照してください。

端末認証、メール確認・復旧、受信者認証の呼び出し手順は[API仕様](docs/api.md)にあります。

## 実装した範囲

- 受信者・宛先ごとの伝言の作成、更新、削除、JSON書き出し、アカウント削除
- 受信者へのメール招待、承諾・拒否・通報、同意の撤回、宛先単位の閲覧制御
- 前面起動・通知への明示反応の確認記録、監視の有効化・停止
- メール警告、猶予期間、固定した公開スナップショット、通知台帳・DB Outbox
- 設定バージョン・書き込みトランザクションによる競合制御、重複排除、失効
- Cronや確認APIの監視断、契約失効、警告不達、配信停止スイッチによる保留
- Expo端末トークン管理、日常プッシュ、自分宛の固定テスト通知
- 10件/50件の契約権利、Apple/Googleサブスクのサーバー検証・復元・Webhook・定期再照会
- Void + React Emailによる日本語メール、Cloudflare Queuesでの配信結果、Expoのticket/receipt照合
- AES-256-GCMによる宛先・本文・端末トークン・Outboxの暗号化と鍵世代管理
- 本番の日本国外アクセス拒否
- `/openapi.json`、マイグレーション、CI、単体・APIテスト、ローカル実環境スモークテスト

Voidメール・Expo・Apple/Googleの接続と検証コードを実装しています。実際の送信・購入試験には各サービスの資格情報、ストアの商品設定、通知先URLが必要です。SMSは対応対象外です。初期フェーズの受信者への最終通知はメールのみで、SMS宛先の登録・送信はできません。受信者Web画面（招待・メール認証・開封前確認・本文表示）は同じHonoに含みます。Expoアプリは別リポジトリです。Cloudflareへの本番リソース作成・本番デプロイは行っていません。

## 初期仕様

| 項目               | この実装での決定                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------- |
| 無反応期間         | 初期30日、7〜365日                                                                           |
| 猶予期間           | 初期7日、3〜30日。警告メールの事業者受付から計算                                             |
| 日常通知           | 登録端末へ1日1回までのプッシュ。配信成功を本人確認に数えない                                 |
| 編集               | 下書き・一時停止・保留中だけ。監視中は先に停止                                               |
| 再開               | 条件確認・同意・有効化が必要。停止時間を遡って発火しない                                     |
| 有効化前提         | 確認済み本人メール、全宛先の受取承諾、各本文、契約権利、自分宛テスト受付、監視正常、送信有効 |
| SMS                | 対応対象外。宛先登録・送信を提供しない                                                       |
| 閲覧               | 256ビットの宛先別トークン＋登録メールのログイン。公開から30日                                |
| 契約失効           | 保留し、公開・未送信通知を止める。更新後も自動再開しない                                     |
| 障害               | Cron・外部確認APIプローブの5分超の欠落で保留。復旧後も本人の再有効化が必要                   |
| 外部送信の取消境界 | `sending`確定後は通知が届く可能性あり。停止時に未送信分と閲覧権限を失効                      |
| 保存対象           | 本文テキストのみ。パスワード・秘密鍵・添付は対象外                                           |

日数等は企画で未確定だったため、コード上の初期仕様として明示しています。利用者向けの同意文はこの動作と一致させてください。`confirmed:true`と`consentVersion:2026-10-13-v1`を有効化時に要求します。

## 監視をローカルで試す

`.dev.vars`に`DELIVERY_ENABLED=true`を追加してWorkerを再起動します。実配信ではなくキャプチャに送られます。

```sh
bun run local probe
bun run local tick
# 過去に監視が途切れていた場合のみ。個々の監視状態は保留のままです。
bun run local recover
# /v1/meを一度呼んでprofileを作成してから:
bun run local grant USER_ID
```

宛先を招待し、受信者のメールリンクでログインして承諾、自分宛テストを受付させた後、有効化します。招待・閲覧は同居する受取Webまたは[API仕様](docs/api.md)のJSONリクエストで試します。日数を待たない状態遷移の検証は、注入した時計を進める`bun test`で行います。

## 本番設定

利用者とDBを日本国内に限定する方針です。`request.cf.country`を使い、国外・国不明の一般APIアクセスを拒否します。IPベースの国判定は居住地の証明ではありません。内部運用・署名付きWebhookには別の認証を設けています。

D1は配置ヒントが日本国内固定の保証にはなりません。従来の東京DB固定という説明は撤回し、本番導入時にデータ所在地の要件を確認します。安全に関わる判定はD1のprimary bindingを使い、リードレプリカの遅延で失効済みリンクを再開しません。[D1のデータ配置](https://developers.cloudflare.com/d1/configuration/data-location/)

設定は `void.config.ts`、環境変数スキーマは `env.ts`、本番の値は `void secret put` で管理します。本番送信元ドメイン、Workers PaidのEmail Sending、カスタムドメインと独立プローブは未設定です。[運用手順](docs/operations.md)に沿って接続してください。

## 構成と参照元

- `routes/` / `src/void-handler.ts` / `src/app.ts`: VoidのURL別ルート、既存HTTP契約と認証・地域制限
- `src/contracts.ts` / `src/openapi.ts`: 入力検証と機械可読仕様
- `src/services/switch.ts`: 所有権、編集、同意、本人確認、失効
- `src/services/scheduler.ts`: 期限判定、警告、スナップショット、障害保留
- `src/services/notifications.ts`: Outbox、送信直前検査、受付と結果照合
- `db/schema.ts` / `src/db/schema.ts` / `db/migrations/`: DrizzleスキーマとSQLマイグレーション
- `src/auth.ts` / `src/services/device-auth.ts` / `src/lib/crypto.ts`: 復旧・受信者のBetter Auth認証、本人の端末認証、保存時暗号化
- `src/integrations/` / `src/services/billing.ts`: Voidメール、Expo、Apple/Google検証・契約更新
- `src/emails/notice.ts`: React Emailの日本語テンプレート

- `crons/monitor.ts`: Void Cronで毎分の監視・通知・契約再検証
- `queues/email-events.ts`: Cloudflare Email Sendingの配信イベント受信
- `src/db/client.ts`: D1の原子的なバッチと競合検査
- `env.ts` / `void.config.ts` / `vite.config.ts`: Void設定と型付き環境変数

要件の参照元は[企画](https://chatgpt.com/space/page_7015eddc4d3c81919a5746fe47c291d0)と[システム構成案](https://chatgpt.com/space/page_f1c38b2175b88191a1061ead9ba6e9ee)です。2026-10-23にサーバー基盤をVoidへ変更しました。Expoアプリ向けのHono Client、認証、課金、停止・開封同意のHTTP契約は維持しています。

## 受取Webのローカル確認

`bun scripts/recipient-web-local.ts`で専用のインメモリDBと外部送信しない認証メールを使い、`http://localhost:8890/__local`から操作できます。別ターミナルで`bun scripts/recipient-web-smoke.ts`を実行すると、実HTTPで認証・preview・開封・停止後失効を確認します。smokeは停止まで進めるため再実行時には専用サーバーを再起動してください。`/__local`経路は検証スクリプトだけに存在し、本番Workerには含みません。

通常の同居構成では`RECIPIENT_WEB_URL`をAPIと同じオリジンに設定します。既存の外部Web用設定は自動変更していません。検証範囲と制約は[受取Web](docs/recipient-web.md)、課金接続案は[RevenueCat](docs/revenuecat-bridge.md)を参照してください。
