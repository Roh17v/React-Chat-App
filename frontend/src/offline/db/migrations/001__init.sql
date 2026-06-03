-- Offline support · Schema v1
-- See `.kiro/specs/offline-support/design.md` §Data Models / Schema v1.
-- Targets SQLite (SQLCipher). Booleans are stored as INTEGER 0|1.
-- Timestamps are TEXT ISO 8601 strings to keep wire-format parity with the backend.
-- JSON-shaped fields are TEXT and (de)serialized by `frontend/src/offline/utils/wireFormat.js`.

-- ---------------------------------------------------------------------------
-- meta: schema and runtime metadata (key/value)
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- users: cached user records (DM contacts, channel members, self)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  first_name TEXT,
  last_name  TEXT,
  email      TEXT,
  username   TEXT,
  image      TEXT,
  color_json TEXT,
  last_seen  TEXT,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- contacts: DM conversation summaries for the current user
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  user_id          TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  last_message     TEXT,
  last_message_at  TEXT,
  unread_count     INTEGER NOT NULL DEFAULT 0,
  bootstrap_status TEXT NOT NULL DEFAULT 'pending',
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_contacts_last_message_at ON contacts(last_message_at DESC);

-- ---------------------------------------------------------------------------
-- channels: cached channel records
-- ---------------------------------------------------------------------------
CREATE TABLE channels (
  channel_id       TEXT PRIMARY KEY,
  channel_name     TEXT NOT NULL,
  admin_user_id    TEXT NOT NULL,
  members_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  bootstrap_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX idx_channels_updated_at ON channels(updated_at DESC);

-- ---------------------------------------------------------------------------
-- channel_members: composite-PK join table for fast member lookups
-- ---------------------------------------------------------------------------
CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_channel_members_user ON channel_members(user_id);

-- ---------------------------------------------------------------------------
-- messages: the canonical local message store
-- Mirrors the server message model field-for-field for clean round-tripping.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id                   TEXT PRIMARY KEY,
  server_id            TEXT,
  client_temp_id       TEXT,
  conversation_id      TEXT NOT NULL,
  conversation_type    TEXT NOT NULL CHECK (conversation_type IN ('dm','channel')),
  sender_id            TEXT NOT NULL,
  receiver_id          TEXT,
  channel_id           TEXT,
  message_type         TEXT NOT NULL CHECK (message_type IN ('text','file','call')),
  content              TEXT,
  file_url             TEXT,
  file_name            TEXT,
  file_metadata_json   TEXT NOT NULL DEFAULT '{}',
  reply_to_json        TEXT,
  status               TEXT NOT NULL CHECK (status IN ('pending','sent','delivered','read','failed')),
  deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
  deleted_for_me       INTEGER NOT NULL DEFAULT 0,
  deleted_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  sync_state           TEXT NOT NULL CHECK (sync_state IN ('local_only','confirmed','tombstoned')),
  queue_seq            INTEGER,
  local_file_path      TEXT
);
CREATE UNIQUE INDEX uq_messages_server_id ON messages(server_id) WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX uq_messages_temp_id   ON messages(client_temp_id) WHERE client_temp_id IS NOT NULL;
CREATE INDEX idx_messages_conv_created    ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_status_pending  ON messages(status) WHERE status IN ('pending','failed');

-- ---------------------------------------------------------------------------
-- outbound_queue: durable FIFO of pending client→server operations
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_queue (
  id                TEXT PRIMARY KEY,
  queue_seq         INTEGER NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN
                       ('send_text','send_file','mark_read','delete_for_me','delete_for_everyone')),
  conversation_id   TEXT NOT NULL,
  conversation_type TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  local_file_path   TEXT,
  client_temp_id    TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  last_error        TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','in_flight','succeeded','failed')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_outbound_drain
  ON outbound_queue(status, next_attempt_at, queue_seq);

-- ---------------------------------------------------------------------------
-- media_cache: per-URL state for downloaded media files (LRU eviction)
-- ---------------------------------------------------------------------------
CREATE TABLE media_cache (
  server_file_url   TEXT PRIMARY KEY,
  local_file_path   TEXT NOT NULL,
  mime_type         TEXT,
  byte_size         INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'downloaded'
                     CHECK (status IN ('not_downloaded','downloading','downloaded','download_failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  downloaded_at     TEXT,
  last_accessed_at  TEXT
);
CREATE INDEX idx_media_lru ON media_cache(last_accessed_at ASC);

-- ---------------------------------------------------------------------------
-- sync_cursors: per-conversation incremental-sync watermarks
-- ---------------------------------------------------------------------------
CREATE TABLE sync_cursors (
  conversation_id   TEXT NOT NULL,
  conversation_type TEXT NOT NULL,
  last_server_id    TEXT,
  last_created_at   TEXT,
  last_synced_at    TEXT,
  PRIMARY KEY (conversation_id, conversation_type)
);

-- ---------------------------------------------------------------------------
-- Seed meta rows (per task 6.1 / Requirements 1.3, 3.1).
-- `local_encryption` defaults to 'none'; EncryptionLayer flips it to 'secure'
-- once the secure-store passphrase is provisioned (Req 10.1, 10.4).
-- `user_id` is intentionally NOT seeded here -- it is set on first
-- authenticated boot by `OfflineProvider` / `repository.init({ userId })`.
-- ---------------------------------------------------------------------------
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
INSERT INTO meta (key, value) VALUES ('local_encryption', 'none');
INSERT INTO meta (key, value) VALUES ('next_queue_seq', '0');
INSERT INTO meta (key, value) VALUES ('media_budget_bytes', '1073741824');
INSERT INTO meta (key, value) VALUES ('media_auto_download_max_bytes', '26214400');
