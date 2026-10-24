# 実D1を使うAPI E2E

```sh
bun install --frozen-lockfile
bun run setup:local
bun run test:e2e
```

BunとNode.jsが必要です。Docker・Turso・本番資格情報は不要です。E2Eはlocalhost:8791を使用します。

ランナーはソース・設定を一時プロジェクトへコピーし、Void CLI/ViteからworkerdとローカルD1を起動します。生成物、依存最適化キャッシュ、D1の状態と接続先メタデータを隔離し、`persistRoot`を確認してから`void db migrate`とfixture用SQLを実行します。失敗・成功時ともプロセスと一時プロジェクトを削除します。開発DBのリセットや本番DBへの接続は行いません。

すべての業務操作は実HTTP、通常のミドルウェア、Better Auth、暗号化、Outbox、実D1を通ります。E2Eは`tests/helpers.ts`、`testD1()`、BunのインメモリSQLite、DB依存の差し替えを使用しません。期限経過、待機中プッシュ、テストケース間の頻度カウンター初期化に限り、隔離D1へCLIでfixtureを設定します。制限の試験はそのケース内で通常のカウントと429を確認します。

ストア検証と通知の外部事業者境界のみ、専用Vite serveモードで差し替えます。課金の所有者照合・復元処理、署名付き汎用Webhook、通知状態遷移は本来の実装です。メールは実際のReact Emailテンプレートで描画します。テスト制御経路はdevelopment専用ファイルかつe2eモード・APP_ENV=test・運用キー必須です。本番ビルドではテスト制御と代替事業者を除外します。Apple/Googleの実署名検証そのものは既存integration/runtime試験で維持し、実購入や実配信の成功とは区別します。

HTTPメソッドとパスの対応は、実際に呼び出した経路をOpenAPIおよびVoidルートと照合します。未試験の公開経路があれば失敗します。Better Authの公開経路は認証リンク・現在セッション・一覧・失効・他セッション失効・サインアウトに限定し、ライブラリが追加する未知の経路は公開しません。各`/v1` JSON成功応答を共有Zodスキーマで検証し、実行結果を`.local/e2e-coverage.json`へ保存します。

対象シナリオは、認証・購読条件、宛先/本文の操作・他者アクセス拒否・version競合、招待・受取承諾、監視・警告・公開・開封同意・失効、通知台帳とWebhookの重複排除、端末更新・上限・未送信プッシュ失効、メール変更・旧認証失効・期限・取消・応答喪失、同一ストア復元・結果回収、アカウント削除、運用APIと受取Webの静的応答です。ブラウザの描画・実機・実サービス資格情報・本番デプロイは含みません。

既存の`bun test`は高速なサービス/単体テストとして維持します。`bun run test:runtime`は本来のVoidメール受信箱と実workerd、偽造Apple署名拒否を引き続き確認します。CIはcheck→build→runtime→E2Eの順で実行します。
