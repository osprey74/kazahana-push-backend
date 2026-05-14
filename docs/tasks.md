# kazahana-push-backend — Tasks

## 進捗サマリー

- Phase 1: 3/3 ✅
- Phase 2: 3/3 ✅
- Phase 3: 1/1 ✅
- Phase 4: 1/1 ✅
- Phase 5: 4/4 ✅
- Phase 6: 3/5

## Phase 1 — API基盤

- [x] DBスキーマ・SQLite接続（`src/db/`）
- [x] Hono APIサーバー・エントリーポイント（`src/index.ts`）
- [x] デバイストークン登録・削除API（`src/routes/device.ts`, `src/utils/auth.ts`）

## Phase 2 — Jetstream・通知ロジック

- [x] Jetstreamクライアント・再接続処理（`src/services/jetstream.ts`）
- [x] 通知対象DID特定ロジック・通知振り分け（`src/services/notifier.ts`）
- [x] handleキャッシュ（`src/services/handleCache.ts`）

## Phase 3 — APNs（iOS）

- [x] APNs送信実装（`src/services/apns.ts`）

## Phase 4 — FCM（Android）

- [x] FCM送信実装（`src/services/fcm.ts`）

## Phase 5 — デプロイ・本番化

- [x] Fly.ioデプロイ・動作確認
- [x] 本番APNs切り替え
- [x] kazahana-ios プッシュ通知統合・実機テスト完了
- [x] kazahana-android プッシュ通知統合・実機テスト完了

## Phase 6 — APNs クライアント刷新（node-apn → Bun fetch）

> **背景**: 2026-05-14 に 23:00 JST 頃と 23:15 JST 頃の 2 回、Sentinel で連続的に約 4 分間の無応答を検知。マシンは生存（`fly status` started）、プロセスも生存。`fly logs` には `node_modules/http2/lib/protocol/connection.js:355` の `MaxListenersExceededWarning`（`wakeup` リスナー 11 個累積）と、Bun の既定警告ハンドラによる http2 stream の巨大オブジェクトダンプ。直後に Jetstream WS が pong timeout で切断 → 自動再接続。
>
> **確定した根本原因**: `node-apn` が内部で使う旧 npm `http2` パッケージは、HTTP/2 のフロー制御ウィンドウが詰まると [connection.js:355](../node_modules/http2/lib/protocol/connection.js#L355) の `this.once('wakeup', this._send.bind(this))` でリスナーを積むだけで、タイムアウトも接続リサイクルも無い。APNs 側の `WINDOW_UPDATE` 遅延・喪失が発生すると永久ハングし、リスナー累積→警告→巨大ダンプでイベントループが圧迫される。約 4 分後の自動復旧は TCP/TLS レイヤがソケットを切るまでの時間に一致。5/13 の Fly ホスト到達不能（`scripts/recover.sh` の対象）とは別事象で、`recover.sh` は今回のケースでは `healthy` を返して終了する。
>
> **採用する方針**: `node-apn` を捨て、Bun の `fetch()` ベースの最小実装に置き換える。APNs HTTP/2 は ES256 JWT 発行 + `POST /3/device/{token}` だけなので 60 行程度。`fetch` に `AbortSignal` で per-call タイムアウト（10s）を付ければ、フロー制御デッドロック自体が起き得ない設計になる。旧 `http2` パッケージ依存ごと消えるのが最大の効果。
>
> **却下した代替案**:
> - `p-limit` で並行度制限: 1 本のハングが他通知を巻き込む構造は残るため症状緩和にしかならない
> - node-apn を残してタイムアウト・接続リサイクルで囲う: node-apn は `AbortSignal` を素直に受け取らず実装が脆い
> - `@parse/node-apn` への差し替え: 内部 `http2` パッケージは同じで根本解決にならない

- [x] APNs クライアントを Bun `fetch` ベースで再実装（`src/services/apns.ts`）
  - ES256 JWT を Bun WebCrypto で署名、30 分キャッシュ
  - `POST https://api.push.apple.com/3/device/{token}`（sandbox は `api.sandbox.push.apple.com`）
  - `AbortSignal` で 10 秒タイムアウト
  - 410 / `Unregistered` / `BadDeviceToken` は `device_tokens` から削除（既存挙動を維持）
- [x] `node-apn` を `package.json` から削除し `bun install` でロックファイル更新（`Removed: 1` 確認済み）
- [x] `process.on("warning", ...)` を `src/index.ts` に追加し、警告本体だけログさせて Bun の既定ハンドラによる巨大オブジェクトダンプを抑止（保険）
- [ ] APNs 本番で実機通知テスト（kazahana-ios 側でフォロー・いいね受信を確認）
- [ ] 旧実装で再現していた MaxListenersExceededWarning が `fly logs` から消えたことを 24h 監視で確認

**デプロイ済み**: 2026-05-14 23:39 JST（`deployment-01KRKESGB145W1W84011YYJ3ZN`）。起動ログに `APNs (Bun fetch) initialized — host=https://api.push.apple.com bundle=com.osprey74.kazahana` が出ていれば新実装が稼働中。
