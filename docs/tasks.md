# kazahana-push-backend — Tasks

## 進捗サマリー

- Phase 1: 3/3 ✅
- Phase 2: 3/3 ✅
- Phase 3: 1/1 ✅
- Phase 4: 1/1 ✅
- Phase 5: 4/4 ✅

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
