# CLAUDE.md — kazahana-push-backend

## プロジェクト概要

kazahana（Blueskyクライアント）のプッシュ通知バックエンドサービス。
Bluesky Jetstreamを購読し、フォロー・いいね・リポストの通知をAPNs（iOS）/ FCM（Android）経由で配信する。

## 技術スタック

- **ランタイム**: Bun
- **Webフレームワーク**: Hono
- **DB**: SQLite（bun:sqlite, WALモード）
- **プッシュ通知**: APNs HTTP/2（node-apn）, FCM HTTP v1（firebase-admin）
- **ホスティング**: Fly.io（nrtリージョン）

## コマンド

- `bun run dev` — 開発サーバー起動（ウォッチモード）
- `bun run start` — 本番サーバー起動

## ディレクトリ構成

```
src/
├── index.ts              # エントリーポイント
├── db/
│   ├── client.ts         # SQLite接続
│   └── migrations.ts     # テーブル定義・初期化
├── routes/
│   └── device.ts         # デバイストークン登録・削除API
├── services/
│   ├── jetstream.ts      # Jetstreamクライアント
│   ├── notifier.ts       # 通知振り分け・無効トークン削除
│   ├── apns.ts           # APNs送信
│   ├── fcm.ts            # FCM送信
│   └── handleCache.ts    # handleキャッシュ（TTL付き）
└── utils/
    └── auth.ts           # APIリクエスト認証
```

## 設計ドキュメント

- `HANDOFF_kazahana-push-backend.md` — 詳細設計書（DB設計、API仕様、通知ペイロード等）

## Shared Skills 設定

- **タスク管理ファイル**: `docs/tasks.md`
- **バージョン更新対象**: `package.json`
- **CI/CD**: Fly.ioデプロイ（手動）

## 注意事項

- APNsサンドボックス/本番は `APNS_PRODUCTION` 環境変数で切り替え
- Jetstreamはベストエフォート（AT Protocol正式仕様外）
- DB1テーブル構成（`device_tokens`のみ）、WALモードは自動有効化
- handleキャッシュのTTLは10分
