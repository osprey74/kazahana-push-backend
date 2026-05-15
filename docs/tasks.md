# kazahana-push-backend — Tasks

## 進捗サマリー

- Phase 1: 3/3 ✅
- Phase 2: 3/3 ✅
- Phase 3: 1/1 ✅
- Phase 4: 1/1 ✅
- Phase 5: 4/4 ✅
- Phase 6: 4/5

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

## Phase 6 — APNs クライアント刷新（node-apn → node:http2）

> **背景**: 2026-05-14 に 23:00 JST 頃と 23:15 JST 頃の 2 回、Sentinel で連続的に約 4 分間の無応答を検知。マシンは生存（`fly status` started）、プロセスも生存。`fly logs` には `node_modules/http2/lib/protocol/connection.js:355` の `MaxListenersExceededWarning`（`wakeup` リスナー 11 個累積）と、Bun の既定警告ハンドラによる http2 stream の巨大オブジェクトダンプ。直後に Jetstream WS が pong timeout で切断 → 自動再接続。
>
> **確定した根本原因**: `node-apn` が内部で使う旧 npm `http2` パッケージは、HTTP/2 のフロー制御ウィンドウが詰まると [connection.js:355](../node_modules/http2/lib/protocol/connection.js#L355) の `this.once('wakeup', this._send.bind(this))` でリスナーを積むだけで、タイムアウトも接続リサイクルも無い。APNs 側の `WINDOW_UPDATE` 遅延・喪失が発生すると永久ハングし、リスナー累積→警告→巨大ダンプでイベントループが圧迫される。約 4 分後の自動復旧は TCP/TLS レイヤがソケットを切るまでの時間に一致。5/13 の Fly ホスト到達不能（`scripts/recover.sh` の対象）とは別事象で、`recover.sh` は今回のケースでは `healthy` を返して終了する。
>
> **採用した方針**: `node-apn` を捨て、`node:http2` + Bun WebCrypto の自前実装に置き換え。connection-per-request で接続状態起因のデッドロックを構造的に排除、per-call の `setTimeout(10s)` でハードキャンセル可能。
>
> **試行錯誤**: 初版は Bun の `fetch()` で実装したが、APNs から `Malformed_HTTP_Response` を連発。Bun 1.3.x の `fetch` は HTTP/1.1 ベースで、APNs（HTTP/2 専用）に対しては不適合。`node:http2`（Bun も実装提供）に切り替えて解決。
>
> **却下した代替案**:
> - `p-limit` で並行度制限: 1 本のハングが他通知を巻き込む構造は残るため症状緩和にしかならない
> - node-apn を残してタイムアウト・接続リサイクルで囲う: node-apn は `AbortSignal` を素直に受け取らず実装が脆い
> - `@parse/node-apn` への差し替え: 内部 `http2` パッケージは同じで根本解決にならない
> - Bun `fetch`: APNs の HTTP/2 要件に対応できない（上記試行で判明）

- [x] APNs クライアントを `node:http2` ベースで再実装（`src/services/apns.ts`）
  - ES256 JWT を Bun WebCrypto で署名、30 分キャッシュ
  - `POST https://api.push.apple.com/3/device/{token}`（sandbox は `api.sandbox.push.apple.com`）
  - connection-per-request（接続再利用なし）で状態起因のハングを構造的に排除
  - per-call `setTimeout(10s)` でハードキャンセル
  - 410 / `Unregistered` / `BadDeviceToken` は `device_tokens` から削除（既存挙動を維持）
- [x] `node-apn` を `package.json` から削除し `bun install` でロックファイル更新（`Removed: 1` 確認済み）
- [x] `process.on("warning", ...)` を `src/index.ts` に追加し、警告本体だけログさせて Bun の既定ハンドラによる巨大オブジェクトダンプを抑止（保険）
- [x] APNs 本番で実機通知テスト — 2026-05-15 20:46 JST 頃、副アカウントからのイイネが本アカウント iPhone に正常着信を確認
- [ ] 旧実装で再現していた MaxListenersExceededWarning が `fly logs` から消えたことを 24h 監視で確認

**デプロイ済み**:
- 2026-05-14 23:39 JST: 初版（Bun `fetch` ベース）— `deployment-01KRKESGB145W1W84011YYJ3ZN`
- 2026-05-15 20:39 JST: 修正版（`node:http2` ベース）— `deployment-01KRNPXSYA651K043DMYNFMXEF`

起動ログに `APNs (node:http2) initialized — host=https://api.push.apple.com bundle=com.osprey74.kazahana` が出ていれば最新版が稼働中。
