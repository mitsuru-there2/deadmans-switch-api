# DB管理

Void標準のD1 / Drizzleマイグレーションを使用します。スキーマの公開入口は`db/schema.ts`、実際の定義は`src/db/schema.ts`です。

## 初期化

まだローカル環境だけで利用しているため、2026-10-24に旧12件のSQL・snapshot・journalを置き換え、`void db generate`で現在のスキーマから初期マイグレーション1本を生成しました。初期SQLは`db/migrations/20261024011334_gigantic_tombstone.sql`です。

新規環境:

```sh
bun run setup:local
bun run prepare
bun run db:migrate
```

旧履歴を適用済みのローカルDBは、開発サーバーを停止してから次の標準コマンドでリセットします。ローカルの登録データを削除し、現在のマイグレーションを再適用します。

```sh
bunx void db reset --yes
```

本番やリモートDBへの操作は行いません。リリース後は適用済みの履歴を置き換えず、追加マイグレーションで変更します。

## スキーマ変更

```sh
bun run db:generate
# 生成SQLを確認
bun run db:migrate
```

SQL、`meta/*_snapshot.json`、`meta/_journal.json`を一緒にコミットします。テーブル・インデックス・外部キーはVoid CLIがDrizzleスキーマから生成します。

アプリ固有のD1競合制御には、`_d1_revision`の初期行と各アプリテーブルのINSERT/UPDATE/DELETEトリガーが必要です。これはDrizzleが自動生成しないため、初期SQLに明示しています。Voidの手書きSQLの規則に従い、各トリガーを`END;`まで1文として保ち、`--> statement-breakpoint`で区切ります。新しいテーブルの追加時も同じトリガーを追加してください。トリガーの網羅・原子性・ロールバックは`tests/d1-atomic.test.ts`、初期化と外部キー動作は`tests/migrations.test.ts`で検証します。
