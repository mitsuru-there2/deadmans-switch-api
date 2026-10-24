# 復元結果の再取得契約

2026-10-14。アプリ main `59a6a1b` の結果不明ロックに対応するAPI側追加。アプリのコードは変更していません。既存Apple/Googleの購入証明検証・登録済み所有者・多段置換鎖・契約条件はそのままです。

## アプリの手順

1. 専用fresh bootstrapのBearerをSecureStoreに保存。OSの暗号学的乱数32bytesを生成し、paddingなしBase64URL 43文字の `operationSecret` にします。UUIDや公開idempotency ID、accountToken、CustomerInfoを代用しません。
2. **送信前に** API origin・fresh Bearer・operationSecret・pending状態を同じSecureStore envelopeへ保存します。保存失敗なら復元を送信しません。購入証明は引き続きメモリだけです。pending中は通常APIとfresh Bearerのdevice-session更新を止めます。
3. `POST /v1/auth/restore` に既存の購入証明と `operationSecret` を追加。Authorizationはfresh Bearer。成功応答は従来どおり `{token,expiresAt,accountToken,userId}`。互換のためoperationSecret省略も受け付けますが、省略した操作には結果再取得を提供しません。
4. 応答喪失・SecureStore切替失敗・再起動時は `POST /v1/auth/restore/result` に `{operationSecret}` と**保存した元のfresh Bearer**を送ります。元の利用中端末Bearer、新しく返されたBearer、Cookieは使いません。購入証明の再送・再購入は不要です。
5. completedならsession全体をSecureStore envelopeへ原子的に置き換え、旧fresh Bearerと操作秘密を消去。その後だけcache破棄・RevenueCat接続・通常APIを再開します。保存完了前にdevice-sessionで新トークンを更新しません。再取得はチェックイン・監視再開・通知再登録を行いません。

```ts
// POST /v1/auth/restore/result — 全成功分岐はHTTP 200
{ status: "completed", session: { token, expiresAt, accountToken, userId }, expiresAt }
{ status: "pending", expiresAt }
{ status: "failed", error: { code }, expiresAt }
```

外側expiresAtは結果再取得期限、session.expiresAtは通常の端末認証期限です。Hono Clientと `RestoreResultResponse` に共有型を追加しました。レスポンスはno-store、IPごと30回/分です。

## 固定・再試行・失敗

- 操作秘密のhash、元fresh Bearerのhash、storeと完全な購入証明のfingerprintを保存します。同じfresh Bearerでの別秘密/別証明、別fresh Bearerでの同じ秘密は409 `RESTORE_OPERATION_CONFLICT`。新しい候補を選ぶ場合は別の復元操作が必要です。今回の新契約は未使用・未契約・未確認のfresh identityだけで開始します。
- 操作はサーバー受付から最大15分。同じ操作の再試行や結果取得では延長しません。同一操作の並行要求は同じ結果に収束しますが、DB競合では503になる場合もあるため結果APIで照合します。
- pendingは未完了であり、未実行の保証ではありません。元のfresh Bearerが有効で完全に同じ購入証明がメモリに残っている場合だけ、同じoperationSecretで元リクエストを再試行できます。再起動後にApple JWSが変わった場合などは別証明への差し替えを拒否します。結果APIを照合し、勝手に別bootstrapや旧アカウントへ戻りません。
- 購入検証の確定的な4xx拒否はfailedとして保存し、同じ操作を再開しません。429/503や不明な内部障害はpendingに残します。認証失効・期限切れ・操作消失が確定した場合、遅延した元リクエストは新しいトークンを発行できません。
- 不明な組み合わせ、期限切れ、失効した結果は404 `RESTORE_RESULT_UNAVAILABLE`。404は「復元が未実行」の証明ではありません。自動的に旧Bearerへ戻らず、別の全面的なストア復元へ進む前に、既存 `DELETE /v1/auth/device-sessions` を**元fresh Bearerで**実行して放棄した要求を止めます。204または元fresh Bearerの401を確認できれば、そのBearerによる遅延した復元は以後コミットできません。通信不明ならロックを保ちます。その後、利用者の明示操作で新bootstrap・OS証明・新操作秘密から復元を始めます。放棄した操作から遅れて届いた応答は、アプリの操作世代を照合して破棄してください。
- fresh bootstrap自体の応答喪失や、operationSecretを送信前に安全に保存できなかった場合は本契約の対象外です。新規キーや一般的な冪等性APIは追加していません。

## 権限と保存

成功した認証結果の暗号化保存、新トークンの発行、旧端末/元fresh identity/セッション/Expo登録の失効は同じDBトランザクションです。保存失敗や保存中の期限超過なら全てロールバック。操作の行には毎回サーバー生成の世代IDがあり、削除後に古い処理が別の操作を完了させることを防ぎます。

結果APIは両方の秘密を持つ要求だけに、**現在も有効な同じ新Bearer**を返します。追加発行や期限延長はしません。新Bearerの更新・失効、アカウント削除、別端末への再復元後は取得不可。失効した元fresh Bearerを一般APIの認証として復活させません。これは2つの秘密の所持による制限であり、ハードウェアの端末証明ではありません。両方が盗まれた場合は15分以内の結果を取得できるため、ログ・URL・分析・SQLiteに保存しません。

結果は既存VaultのAES-GCMと既存ENCRYPTION_KEYSで暗号化し、操作の世代IDをAADに結び付けます。新しい秘密鍵・環境変数は不要です。DBにはrawの元Bearer、操作秘密、購入証明を保存しません。15分後はCronが止まっていても返却不可、次のCronで結果暗号文と結果token hashを消去し、放棄されたfresh Bearerも失効。再実行防止用のhash・状態・期限などは受付から24時間で削除します。復元先アカウント削除時は関連する成功操作も削除します。DBバックアップの保持期間は既存運用に従い、バックアップ中の暗号文まで15分で消去する保証はありません。DBと暗号鍵の同時漏えいは本方式の保護範囲外です。

必要なテーブルは現在の初期マイグレーションに含まれます。2026-10-24にVoid CLIで履歴を再生成し、リセットしたローカルD1へ適用しました。本番配信・稼働DB変更・実ストア通信・新規認証情報発行は実施していません。
