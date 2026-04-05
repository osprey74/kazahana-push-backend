# HANDOFF: kazahana-push-backend

## 概要

kazahana（Blueskyクライアント）のプッシュ通知バックエンドサービス。
Bluesky Jetstreamを購読し、kazahanaユーザー全員に対して
フォロー・いいね・リポストの通知をAPNs（iOS）およびFCM（Android）経由で配信する。

- 運用コストは高く見積もっても月額$10程度であり、全ユーザーへの無償提供とする
- **対象はiOSとAndroidのみ。** デスクトップ（Windows / macOS）はアプリ起動中のTauriポーリング通知で対応済みのため対象外

---

## プラットフォーム方針

| プラットフォーム | 通知方式 | バックエンド |
|---|---|---|
| **iOS** | APNs経由プッシュ通知 | **本サービス** |
| **Android** | FCM経由プッシュ通知 | **本サービス** |
| macOS | Tauriポーリング通知（既存機能） | 不要 |
| Windows | Tauriポーリング通知（既存機能） | 不要 |

---

## 技術スタック

| 要素 | 採用技術 | 理由 |
|---|---|---|
| ランタイム | **Bun** | TypeScript-native、高速、SQLite内蔵 |
| Webフレームワーク | **Hono** | 軽量・型安全・Bun対応 |
| DB | **SQLite（bun:sqlite）** | 追加コストゼロ、このスケールで十分 |
| プッシュ（iOS） | **APNs HTTP/2（JWT認証）** | node-apn ライブラリ |
| プッシュ（Android） | **FCM HTTP v1** | firebase-admin SDK |
| ホスティング | **Fly.io（nrtリージョン）** | 月$5〜10、既存インフラと統一 |

---

## リポジトリ構成

```
kazahana-push-backend/
├── src/
│   ├── index.ts              # エントリーポイント・サーバー起動
│   ├── db/
│   │   ├── client.ts         # SQLite接続・WALモード設定
│   │   └── migrations.ts     # テーブル定義・初期化
│   ├── routes/
│   │   └── device.ts         # デバイストークン登録・削除API
│   ├── services/
│   │   ├── jetstream.ts      # Jetstreamクライアント・再接続処理
│   │   ├── notifier.ts       # 通知振り分け（APNs/FCM）・無効トークン削除
│   │   ├── apns.ts           # APNs送信
│   │   ├── fcm.ts            # FCM送信
│   │   └── handleCache.ts    # handleキャッシュ（TTL付きメモリキャッシュ）
│   └── utils/
│       └── auth.ts           # APIリクエスト認証（Bearer token）
├── fly.toml
├── Dockerfile
├── .env.example
└── package.json
```

---

## データベース設計

### テーブル定義（`src/db/migrations.ts`）

```typescript
export const MIGRATIONS = `
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS device_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    did         TEXT NOT NULL,
    token       TEXT NOT NULL,
    platform    TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(did, platform)
  );

  CREATE INDEX IF NOT EXISTS idx_device_tokens_did ON device_tokens(did);
`;
```

テーブルは `device_tokens` の1つのみ。

### WALモードについて

JetstreamクライアントとHTTPリクエストハンドラが同時にDBへ書き込むため必須。
MIGRATIONSの先頭に含まれるため自動で有効化される。

---

## API設計

### 認証

全APIリクエストは `Authorization: Bearer {API_SECRET}` ヘッダーを要求する。
`API_SECRET` は環境変数で管理し、kazahanaアプリのビルド時に埋め込む。

---

### 1. デバイストークン登録

**`POST /api/device-token`**

kazahanaアプリ起動時・フォアグラウンド復帰時に呼び出す。
マルチユーザー対応のため、DID単位で登録する（同一デバイスに複数DIDが存在しうる）。

```typescript
// Request
{
  "did": "did:plc:xxxxxxxxxxxx",
  "token": "APNs or FCM device token",
  "platform": "ios" | "android"
}

// Response 200
{ "ok": true }
```

処理：`device_tokens` テーブルに UPSERT（同一DID+platformは上書き）

---

### 2. デバイストークン削除

**`DELETE /api/device-token`**

ログアウト時・通知オフ設定時に呼び出す。

```typescript
// Request
{
  "did": "did:plc:xxxxxxxxxxxx",
  "platform": "ios" | "android"
}

// Response 200
{ "ok": true }
```

---

## Jetstreamクライアント（`src/services/jetstream.ts`）

### 接続設定

```typescript
const JETSTREAM_URL =
  "wss://jetstream2.us-east.bsky.network/subscribe" +
  "?wantedCollections=app.bsky.graph.follow" +
  "&wantedCollections=app.bsky.feed.like" +
  "&wantedCollections=app.bsky.feed.repost";
```

### イベント処理フロー

```
Jetstreamからイベント受信
  ↓
collectionに応じて通知対象DIDを特定（メモリ内処理）
  ↓
device_tokensテーブルで該当DIDのトークンを検索
  ↓
トークンが存在する場合のみ通知処理へ
  ↓
actor・target のhandleを取得（handleCache経由）
  ↓
APNs/FCMに送信
```

DBアクセスはヒット時のみとし、I/Oを最小化する。

### 通知対象DIDの特定ロジック

| collection | 通知対象DID（target） | 取得元 |
|---|---|---|
| `app.bsky.graph.follow` | フォローされた側 | `commit.record.subject` |
| `app.bsky.feed.like` | いいねされた投稿の作者 | `commit.record.subject.uri`（`at://did:plc:xxx/...` からDIDを抽出） |
| `app.bsky.feed.repost` | リポストされた投稿の作者 | 同上 |

### リポストへのリポスト・リポストへのいいねについて

AT Protocolの仕様上、`like` および `repost` の `subject.uri` は常に**オリジナル投稿のURIを指す**。
「リポストへのいいね」「リポストへのリポスト」も元投稿者に通知が届く。
これはBluesky公式アプリと同じ挙動であり、追加実装は不要。

### 再接続処理

WebSocket切断時は指数バックオフで再接続（初回1秒、最大60秒）。
`cursor`（最後に処理したイベントのマイクロ秒タイムスタンプ）をメモリに保持し、
再接続時に渡してイベントの取りこぼしを防ぐ。

```typescript
let cursor: number | undefined = undefined;

ws.on('message', (data) => {
  const event = JSON.parse(data);
  cursor = event.time_us;
  handleEvent(event);
});

// 再接続時
const url = cursor
  ? `${JETSTREAM_URL}&cursor=${cursor}`
  : JETSTREAM_URL;
```

---

## handleキャッシュ（`src/services/handleCache.ts`）

actor・target 両方のhandleを `app.bsky.actor.getProfile` で取得し、
TTL付きメモリキャッシュに保存してAPIコールを抑制する。

```typescript
// キャッシュの構造
const cache = new Map<string, { handle: string; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000; // 10分

export async function getHandle(did: string): Promise<string> {
  const cached = cache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.handle;

  const profile = await fetchProfile(did); // app.bsky.actor.getProfile
  cache.set(did, { handle: profile.handle, expiresAt: Date.now() + TTL_MS });
  return profile.handle;
}
```

---

## 通知ペイロード設計

### バッジについて（非実装・方針確定）

バッジ（アプリアイコンの数字）は**全プラットフォームで実装しない**。

理由：
- kazahanaはマルチユーザー対応であり、どのアカウントの未読数を表示すべきか判別できない
- `badge: 1` 固定は「通知が1件だけある」という誤解を招く
- 通知バナーの表示のみで十分な実用性がある

### 通知文言

マルチユーザー環境でどのアカウントへの通知かが一目でわかるよう、
actor（操作した人）と target（操作された側のkazahanaアカウント）を両方含める。

| イベント | 通知文 |
|---|---|
| follow | `@{actor} さんが @{target} をフォローしました` |
| like | `@{actor} さんが @{target} の投稿にいいねしました` |
| repost | `@{actor} さんが @{target} の投稿をリポストしました` |

### マルチユーザー対応

ペイロードに `target_did` を含め、アプリ側でタップ時のアカウント特定に使用する。

### APNs（iOS）

```typescript
// node-apn ライブラリを使用
{
  aps: {
    alert: {
      title: "kazahana",
      body: "@actor さんが @target をフォローしました"
    },
    sound: "default"
    // badge: 含めない（方針確定）
  },
  target_did: "did:plc:xxxxxxxxxxxx"
}
```

### FCM（Android）

```typescript
// firebase-admin を使用
{
  notification: {
    title: "kazahana",
    body: "@actor さんが @target の投稿にいいねしました"
  },
  data: {
    target_did: "did:plc:xxxxxxxxxxxx"
  },
  android: {
    notification: {
      sound: "default"
      // notification_count: 含めない（方針確定）
    }
  }
}
```

---

## デバイストークン無効化処理（`src/services/notifier.ts`）

APNs/FCMから無効トークンエラーが返った場合、`device_tokens` から該当レコードを削除する。

```typescript
// APNs: HTTPステータス 410 (Gone) が返った場合
// FCM: error.code === 'messaging/registration-token-not-registered' の場合
db.run(
  `DELETE FROM device_tokens WHERE token = ?`,
  [invalidToken]
);
```

---

## 環境変数（`.env.example`）

```env
# API認証（kazahanaアプリにビルド時埋め込み）
API_SECRET=your-secret-key-here

# APNs（iOS）
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=XXXXXXXXXX
APNS_KEY_PATH=/app/secrets/AuthKey.p8
APNS_BUNDLE_ID=com.osprey74.kazahana
APNS_PRODUCTION=false  # 本番時はtrue

# FCM（Android）
FCM_PROJECT_ID=kazahana-android
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/firebase-adminsdk.json

# Jetstream
JETSTREAM_URL=wss://jetstream2.us-east.bsky.network/subscribe

# SQLite
DATABASE_PATH=/data/kazahana-push.db

# ログ
LOG_LEVEL=info
```

---

## Fly.io設定

### `fly.toml`

```toml
app = "kazahana-push-backend"
primary_region = "nrt"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"

[mounts]
  source = "kazahana_push_data"
  destination = "/data"
```

### `Dockerfile`

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
```

---

## kazahanaアプリ側の対応（実装メモ）

### iOS（kazahana-ios）

- `UNUserNotificationCenter` で通知許可を取得
- APNsデバイストークンを取得し `POST /api/device-token` に登録
- ログアウト時に `DELETE /api/device-token` を呼ぶ
- アプリ起動・フォアグラウンド復帰時に `setBadgeCount(0)` でバッジをリセット
- 通知タップ時、ペイロードの `target_did` で対象アカウントに切り替えてから通知一覧を表示

### Android（kazahana-android）

- `FirebaseMessaging.getInstance().token` を取得
- `POST /api/device-token` に登録
- ログアウト時に `DELETE /api/device-token` を呼ぶ
- 通知タップ時、`data.target_did` で対象アカウントに切り替えてから通知一覧を表示

### macOS / Windows（対象外）

- バックグラウンドプッシュ通知は実装しない
- アプリ起動中のTauriポーリング通知（既存機能）で対応済み

---

## 実装優先順位

| フェーズ | 内容 |
|---|---|
| **Phase 1** | DBスキーマ・Hono APIサーバー・デバイストークン登録・削除API |
| **Phase 2** | Jetstreamクライアント・通知対象DID特定ロジック・handleキャッシュ |
| **Phase 3** | APNs送信（iOS） |
| **Phase 4** | FCM送信（Android） |
| **Phase 5** | Fly.ioデプロイ・本番APNs切り替え・動作確認 |

---

## 注意事項・既知の制約

- **APNsサンドボックス/本番の切り替え**：`APNS_PRODUCTION` 環境変数で制御。開発中は `false`
- **Jetstreamはベストエフォート**：AT Protocol正式仕様外のため、将来的なAPI変更に注意
- **SQLite WALモード**：MIGRATIONSの先頭に含まれるため自動で有効化される
- **Bluesky全体のイベントを受信**：フィルタリング処理はメモリ内で行い、DBアクセスはヒット時のみ
- **handleキャッシュ**：actor・target 両方をキャッシュすること（TTL: 10分）

---

## 関連リポジトリ

| リポジトリ | 用途 |
|---|---|
| `kazahana` | デスクトップ（Tauri v2 + React）本体 |
| `kazahana-ios` | iOS（Swift/SwiftUI）本体 |
| `kazahana-android` | Android（Kotlin/Jetpack Compose）本体 |
| `kazahana-push-backend` | **本リポジトリ（新規作成）** |

---

## クライアント側改修に必要な情報

### バックエンド接続情報

| 項目 | 値 |
|---|---|
| エンドポイント | `https://kazahana-push-backend.fly.dev` |
| 認証ヘッダー | `Authorization: Bearer {API_SECRET}` |
| トークン登録 | `POST /api/device-token` |
| トークン削除 | `DELETE /api/device-token` |

`API_SECRET` はビルド時にアプリに埋め込む。値はFly.ioシークレットに設定済み。

### リクエスト例

```typescript
// 登録
POST /api/device-token
Headers: { "Authorization": "Bearer {API_SECRET}", "Content-Type": "application/json" }
Body: { "did": "did:plc:xxxxxxxxxxxx", "token": "デバイストークン", "platform": "ios" | "android" }

// 削除
DELETE /api/device-token
Headers: { "Authorization": "Bearer {API_SECRET}", "Content-Type": "application/json" }
Body: { "did": "did:plc:xxxxxxxxxxxx", "platform": "ios" | "android" }
```

### 通知ペイロード（アプリ側で受信する構造）

**iOS（APNs）:**
```json
{
  "aps": {
    "alert": { "title": "kazahana", "body": "@actor さんが @target をフォローしました" },
    "sound": "default"
  },
  "target_did": "did:plc:xxxxxxxxxxxx"
}
```

**Android（FCM）:**
```json
{
  "notification": { "title": "kazahana", "body": "@actor さんが @target の投稿にいいねしました" },
  "data": { "target_did": "did:plc:xxxxxxxxxxxx" }
}
```

### 各プラットフォームの実装タスク

**iOS（kazahana-ios）:**
1. `UNUserNotificationCenter` で通知許可を取得
2. APNsデバイストークンを取得し `POST /api/device-token` に登録
3. ログアウト時・通知オフ時に `DELETE /api/device-token` を呼ぶ
4. アプリ起動・フォアグラウンド復帰時に `setBadgeCount(0)` でバッジリセット
5. 通知タップ時、ペイロードの `target_did` で対象アカウントに切り替えてから通知一覧を表示

**Android（kazahana-android）:**
1. `FirebaseMessaging.getInstance().token` でFCMトークンを取得
2. `POST /api/device-token` に登録
3. ログアウト時・通知オフ時に `DELETE /api/device-token` を呼ぶ
4. 通知タップ時、`data.target_did` で対象アカウントに切り替えてから通知一覧を表示

### 現在のバックエンド状態（2026-04-05時点）

| コンポーネント | 状態 | 備考 |
|---|---|---|
| ヘルスチェック | ✅ passing | `GET /health` |
| Jetstream | ✅ connected | follow/like/repost を購読中 |
| APNs（iOS） | ✅ initialized | **Sandbox モード**（`APNS_PRODUCTION=false`） |
| FCM（Android） | ⏳ 未設定 | Firebase認証ファイル取得後に `flyctl secrets set` で追加 |

### 本番切り替え手順

- **APNs本番化**（App Store配布時）: `flyctl secrets set APNS_PRODUCTION=true`
- **FCM有効化**: Firebase Consoleからサービスアカウントキー（JSON）を取得後、`flyctl secrets set GOOGLE_APPLICATION_CREDENTIALS_JSON="$(cat firebase-adminsdk.json)" FCM_PROJECT_ID=kazahana-android` を実行し、`src/services/fcm.ts` を環境変数からJSON読み込みに対応させる

---

*作成日：2026-04-05*
*対象：Claude Code向けHANDOFF*
