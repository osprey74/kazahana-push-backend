# kazahana-push-backend

Push notification backend for [kazahana](https://github.com/osprey74/kazahana), an open-source Bluesky client.

Subscribes to [Bluesky Jetstream](https://docs.bsky.app/blog/jetstream) and delivers push notifications for follows, likes, and reposts via APNs (iOS) and FCM (Android).

## Architecture

```
Bluesky Jetstream (WebSocket)
        │
        ▼
  kazahana-push-backend (Bun + Hono)
        │
        ├─ SQLite (device token registry)
        │
        ├─► APNs → iOS devices
        └─► FCM  → Android devices
```

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Web framework | [Hono](https://hono.dev) |
| Database | SQLite (bun:sqlite, WAL mode) |
| Push (iOS) | APNs HTTP/2 via [node-apn](https://github.com/node-apn/node-apn) |
| Push (Android) | FCM HTTP v1 via [firebase-admin](https://firebase.google.com/docs/admin/setup) |
| Hosting | [Fly.io](https://fly.io) (nrt region) |

## API

All endpoints require `Authorization: Bearer {API_SECRET}`.

### Register device token

```
POST /api/device-token
```

```json
{
  "did": "did:plc:xxxxxxxxxxxx",
  "token": "device-token-string",
  "platform": "ios" | "android"
}
```

### Delete device token

```
DELETE /api/device-token
```

```json
{
  "did": "did:plc:xxxxxxxxxxxx",
  "platform": "ios" | "android"
}
```

### Health check

```
GET /health
```

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1+

### Install

```bash
bun install
```

### Environment variables

Copy `.env.example` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `API_SECRET` | Bearer token for API authentication |
| `APNS_KEY` | APNs private key (.p8 content) |
| `APNS_KEY_ID` | APNs Key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_BUNDLE_ID` | App bundle identifier |
| `APNS_PRODUCTION` | `true` for production, `false` for sandbox |
| `FCM_PROJECT_ID` | Firebase project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Firebase service account JSON |
| `DATABASE_PATH` | SQLite database file path |

### Run

```bash
bun run dev    # development (watch mode)
bun run start  # production
```

## Deployment

Deployed on Fly.io. See `fly.toml` for configuration.

```bash
flyctl deploy
```

## Platform Support

| Platform | Notification method |
|---|---|
| iOS | Push via APNs (this service) |
| Android | Push via FCM (this service) |
| macOS / Windows | In-app polling (handled by Tauri client) |

## License

MIT
