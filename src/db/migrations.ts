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
