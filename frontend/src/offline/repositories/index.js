// @ts-check
/**
 * Repository singleton — the single seam between the offline store and the
 * UI / Sync_Engine / Outbound_Queue.
 *
 * Implements task 7.1 of the offline-support spec, covering Requirements 1.1,
 * 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.3, 2.4, and 3.5. Write methods
 * (`applyServerMessages`, `applyLiveMessage`, `applyDeletion`,
 * `applyStatusUpdate`) land in task 7.2 and are now serialized through the
 * `PerConversationMutex` (task 7.3, Req 5.6 / 5.7). Outbound queue methods
 * (`enqueueOutbound`, `markOutboundConfirmed`, `markOutboundFailed`) are
 * implemented in task 10.1 — they allocate `queueSeq` atomically (Req 6.1),
 * insert the optimistic `messages` row for `send_text`/`send_file`
 * (Req 7.2), and merge server confirmations through the conflict resolver
 * by `clientTempId` (Req 6.4 / Property 8). The drain loop / retry /
 * connectivity wiring lives in
 * `frontend/src/offline/sync/OutboundQueue.js`.
 *
 * Design references:
 *   - §3.1 Repository interface (ConversationType / LocalMessage / write contract)
 *   - §Data Models / Schema v1 (snake_case → camelCase row mapping)
 *   - §3.5 Single-writer serialization (PerConversationMutex — task 7.3)
 *   - §3.6 Conflict resolution (writes — task 7.2 / 8.1)
 *   - §3.12 OfflineProvider lifecycle (drives `init`, `wipe`, user-switch)
 *
 * Boot sequence (Req 2.4 / Req 10.x):
 *   1. EncryptionLayer.getOrCreatePassphrase() — secret-store probe + 32-byte
 *      key generation on first run; returns `{ mode, passphrase }`. The
 *      `mode` is persisted into `meta.local_encryption` so Diagnostics can
 *      report whether the DB on disk is SQLCipher-protected (Req 10.4).
 *   2. sqlite.driver.open({ dbName, passphrase }) — connection lifecycle
 *      §3.2. The driver short-circuits to `PLATFORM_UNSUPPORTED` on
 *      non-native runtimes so vite dev / jsdom tests do not invoke the
 *      Capacitor plugin.
 *   3. Migrator.applyPending(driver) — schema v1 (and any future migrations)
 *      land transactionally per §3.2 / Req 3.2.
 *   4. user-switch detection: if `meta.user_id` is set and disagrees with
 *      `init({ userId })`, wipe local data before persisting the new user_id
 *      so one user's history never leaks into another's session (§Migration
 *      plan / Req 1.6).
 *
 * @module offline/repositories
 */

import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { v4 as uuidv4 } from "uuid";

import {
  applyPending as applyPendingMigrations,
  CODE_VERSION,
} from "../db/Migrator.js";
import { getSqliteDriver } from "../db/drivers/sqlite.driver.js";
import { getEncryptionLayer } from "../services/EncryptionLayer.js";
import { resolveAndApply } from "../sync/conflictResolver.js";
import { STATUS_RANK } from "../sync/statusLifecycle.js";
import { getDiagnostics } from "../utils/Diagnostics.js";
import {
  createPerConversationMutex,
  GLOBAL_MUTEX_KEY,
} from "../utils/PerConversationMutex.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Logical SQLite database name. Mirrors the `DB_NAME` constant called out in
 * design §3.2; kept identical so the test driver and the production driver
 * agree on the file name when the boot path inspects archive backups.
 */
export const DB_NAME = "syncronus_offline";

/**
 * Capacitor `Filesystem.Directory.Data` is the app-private sandbox on
 * Android (and the Documents directory on iOS). Files placed under this
 * directory are removed by the OS when the app is uninstalled — so wiping
 * here together with the SQLCipher key satisfies Req 1.6 / Req 10.5.
 */
const MEDIA_DIRECTORY = Directory.Data;

/**
 * Sub-path under {@link MEDIA_DIRECTORY} that holds every cached media
 * artifact (chat files, thumbnails, profile images, outbound staging).
 * Matches the on-disk layout described in §3.7.
 */
const MEDIA_DIRECTORY_PATH = "files/media";

/**
 * Default per-conversation retention bound (Req 1.7). The repository keeps
 * the most-recent N messages per conversation; everything older is pruned
 * after every committed write. The bound is configurable per conversation
 * via the `messages_retention_max` meta key — when the row is absent we
 * fall back to this default.
 */
export const DEFAULT_MESSAGES_RETENTION_MAX = 500;

/**
 * Status values that count as "live" for {@link RepositoryInterface.getOutboundQueue}.
 * `succeeded` rows are pruned by the queue compactor (§3.4) so excluding
 * them here keeps the API result aligned with what the UI / SyncEngine
 * actually need to reason about. `failed` rows stay visible so the user can
 * tap "retry" (Req 6.5 / Req 6.6).
 */
const ACTIVE_OUTBOUND_STATUSES = ["queued", "in_flight", "failed"];

// ---------------------------------------------------------------------------
// Types (JSDoc only — the project does not ship TypeScript)
// ---------------------------------------------------------------------------

/**
 * @typedef {"dm" | "channel"} ConversationType
 */

/**
 * @typedef {"pending" | "sent" | "delivered" | "read" | "failed"} MessageStatus
 */

/**
 * @typedef {"local_only" | "confirmed" | "tombstoned"} SyncState
 */

/**
 * Local DB row shape exposed to the UI / SyncEngine. Keys are camelCase even
 * though the SQLite columns are snake_case; the row mapper below performs
 * the conversion.
 *
 * @typedef {Object} LocalMessage
 * @property {string} id
 * @property {string | null} serverId
 * @property {string | null} clientTempId
 * @property {string} conversationId
 * @property {ConversationType} conversationType
 * @property {string} senderId
 * @property {string | null} receiverId
 * @property {string | null} channelId
 * @property {"text" | "file" | "call"} messageType
 * @property {string | null} content
 * @property {string | null} fileUrl
 * @property {string | null} fileName
 * @property {string} fileMetadataJson
 * @property {string | null} replyToJson
 * @property {MessageStatus} status
 * @property {0 | 1} deletedForEveryone
 * @property {0 | 1} deletedForMe
 * @property {string | null} deletedAt
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {SyncState} syncState
 * @property {number | null} queueSeq
 * @property {string | null} localFilePath
 */

/**
 * @typedef {Object} ContactLastMessageMeta
 * @property {"text" | "file" | "call"} type
 * @property {boolean} deletedForEveryone
 * @property {string | null} senderId
 */

/**
 * @typedef {Object} ContactRow
 * @property {string} _id            User id (matches the existing UI shape).
 * @property {string | null} firstName
 * @property {string | null} lastName
 * @property {string | null} email
 * @property {string | null} username
 * @property {string | null} image
 * @property {{ bgColor?: string, textColor?: string } | null} color
 * @property {string | null} lastSeen
 * @property {string | null} lastMessage      Derived from the messages table (see getContacts).
 * @property {string | null} lastMessageAt    Derived from the messages table (see getContacts).
 * @property {ContactLastMessageMeta} lastMessageMeta  Raw fields for WhatsApp-style preview formatting.
 * @property {number} unreadCount
 * @property {string} bootstrapStatus
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ChannelRow
 * @property {string} _id
 * @property {string} channelName
 * @property {string} admin
 * @property {string[]} members
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} bootstrapStatus
 */

/**
 * @typedef {Object} OutboundItem
 * @property {string} id
 * @property {number} queueSeq
 * @property {"send_text"|"send_file"|"mark_read"|"delete_for_me"|"delete_for_everyone"} kind
 * @property {string} conversationId
 * @property {ConversationType} conversationType
 * @property {string} payloadJson
 * @property {string | null} localFilePath
 * @property {string | null} clientTempId
 * @property {number} attempts
 * @property {string | null} nextAttemptAt
 * @property {string | null} lastError
 * @property {"queued"|"in_flight"|"succeeded"|"failed"} status
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} InitResult
 */

/**
 * @typedef {Object} RepositoryDriver
 *   Subset of the SqliteDriver / TestSqliteDriver surface the repository
 *   depends on. Both `sqlite.driver.js` and `sqlite.testDriver.js` already
 *   satisfy this shape.
 * @property {(opts: { dbName: string, passphrase: string, readOnly?: boolean }) => Promise<{ ok: true } | { ok: false, reason: string }>} [open]
 *   Optional — the test driver's `open()` takes no arguments. Production
 *   code provides the full signature.
 * @property {() => Promise<void>} close
 * @property {(sql: string) => Promise<void>} exec
 * @property {(sql: string, values?: unknown[]) => Promise<{ changes: number, lastId?: number }>} run
 * @property {<T = unknown>(sql: string, values?: unknown[]) => Promise<T[]>} query
 * @property {<T>(work: (tx: RepositoryDriver) => Promise<T>) => Promise<T>} withTransaction
 * @property {() => boolean} [isOpen]
 * @property {(dbName: string) => Promise<void>} [deleteDatabase]
 */

/**
 * @typedef {Object} CreateRepositoryOptions
 * @property {RepositoryDriver} [driver]
 *   SQLite driver to use. Defaults to {@link getSqliteDriver}. Tests inject
 *   `createTestSqliteDriver()` here.
 * @property {{ getOrCreatePassphrase: () => Promise<{ mode: string, passphrase: string }>, destroy: () => Promise<void>, diagnoseAvailability?: () => Promise<{ available: boolean, reason?: string }> }} [encryption]
 *   Encryption layer. Defaults to {@link getEncryptionLayer}. Tests pass a
 *   stub that returns `{ mode: "none", passphrase: "" }` so the test driver
 *   (which is not SQLCipher-aware) is exercised on the unencrypted path.
 * @property {{ log: (e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void, snapshot?: () => unknown }} [diagnostics]
 *   Diagnostics sink. Defaults to {@link getDiagnostics}.
 * @property {(driver: RepositoryDriver, opts?: { dbName?: string }) => Promise<{ ok: true, schemaVersion: number } | { ok: false, reason: string, error?: string }>} [migrate]
 *   Migration runner. Defaults to {@link applyPendingMigrations}.
 * @property {boolean} [skipDriverOpen]
 *   When true, `init()` does not call `driver.open(...)`. Used by tests that
 *   pre-open `createTestSqliteDriver()` themselves.
 * @property {{ rmdir: (opts: { path: string, directory: string, recursive?: boolean }) => Promise<unknown>, mkdir?: (opts: { path: string, directory: string, recursive?: boolean }) => Promise<unknown>, stat?: (opts: { path: string, directory: string }) => Promise<unknown> }} [filesystem]
 *   Capacitor `Filesystem` shim. Defaults to the real plugin on native
 *   platforms, and to a no-op stub elsewhere so wipe() does not blow up
 *   when the plugin is absent.
 * @property {() => boolean} [isNativePlatform]
 *   Defaults to `Capacitor.isNativePlatform()`. Tests pass `() => false` so
 *   the no-op filesystem stub is used.
 * @property {{ acquire: (key: string) => Promise<() => void>, withLock: <T>(key: string, work: () => Promise<T> | T) => Promise<T> }} [mutex]
 *   Per-conversation FIFO mutex used to serialize repository writes
 *   (§3.5 / Req 5.6 / Req 5.7). Defaults to a fresh
 *   {@link createPerConversationMutex} instance scoped to this repository
 *   so two `createRepository()` calls in a test suite never share a lock
 *   chain. Tests can inject a stub that records `acquire` order.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a SQLite value (which may be `null`, `undefined`, or a number stored
 * as text) into either a non-empty string or `null`. Centralizing the
 * normalization keeps the row mapper terse.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function toNullableString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  return String(value);
}

/**
 * Coerce a SQLite integer (which may be returned as a number, a string, or a
 * `BigInt`) into a plain JS number. Defaults to `0` when the value is
 * missing — none of the integer columns we read this way are nullable.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toIntegerOrZero(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNullableInteger(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a JSON string column with a typed fallback. Never throws.
 *
 * @template T
 * @param {unknown} value
 * @param {T} fallback
 * @returns {T | unknown}
 */
function parseJsonOrFallback(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Map a `messages` row from snake_case columns to the camelCase
 * {@link LocalMessage} shape. Booleans are normalized to 0|1 so the
 * downstream conflict resolver can compare them against server payloads
 * with a single `===` check.
 *
 * @param {Record<string, unknown>} row
 * @returns {LocalMessage}
 */
function mapMessageRow(row) {
  return {
    id: String(row.id),
    serverId: toNullableString(row.server_id),
    clientTempId: toNullableString(row.client_temp_id),
    conversationId: String(row.conversation_id),
    conversationType: /** @type {ConversationType} */ (row.conversation_type),
    senderId: String(row.sender_id),
    receiverId: toNullableString(row.receiver_id),
    channelId: toNullableString(row.channel_id),
    messageType: /** @type {LocalMessage["messageType"]} */ (row.message_type),
    content: toNullableString(row.content),
    fileUrl: toNullableString(row.file_url),
    fileName: toNullableString(row.file_name),
    fileMetadataJson:
      typeof row.file_metadata_json === "string" ? row.file_metadata_json : "{}",
    replyToJson: toNullableString(row.reply_to_json),
    status: /** @type {MessageStatus} */ (row.status),
    deletedForEveryone: toIntegerOrZero(row.deleted_for_everyone) ? 1 : 0,
    deletedForMe: toIntegerOrZero(row.deleted_for_me) ? 1 : 0,
    deletedAt: toNullableString(row.deleted_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncState: /** @type {SyncState} */ (row.sync_state),
    queueSeq: toNullableInteger(row.queue_seq),
    localFilePath: toNullableString(row.local_file_path),
  };
}

/**
 * Map a joined `contacts` + `users` row to the UI-friendly contact shape.
 * The UI consumes `_id` / `firstName` / etc. (see `ContactList.jsx`), so we
 * project to that shape rather than to a snake_case mirror of the table.
 *
 * `lastMessage` / `lastMessageAt` / `lastMessageMeta` are derived from the
 * messages subquery in getContacts (source of truth). The cached columns on
 * the contacts row are used only as a fallback for the cold-start window
 * before any per-conversation messages have been hydrated locally.
 *
 * @param {Record<string, unknown>} row
 * @returns {ContactRow}
 */
function mapContactRow(row) {
  const derivedContent =
    row.last_message_content != null ? String(row.last_message_content) : null;
  const derivedType =
    row.last_message_type != null ? String(row.last_message_type) : "text";
  const derivedDeleted =
    row.last_deleted_for_everyone != null
      ? Number(row.last_deleted_for_everyone) === 1
      : false;
  const derivedSenderId =
    row.last_message_sender_id != null
      ? String(row.last_message_sender_id)
      : null;
  const derivedCreatedAt =
    row.last_message_created_at != null
      ? String(row.last_message_created_at)
      : null;

  const lastMessage =
    derivedContent != null ? derivedContent : toNullableString(row.last_message_cached);
  const lastMessageAt =
    derivedCreatedAt != null
      ? derivedCreatedAt
      : toNullableString(row.last_message_at_cached);

  return {
    _id: String(row.user_id),
    firstName: toNullableString(row.first_name),
    lastName: toNullableString(row.last_name),
    email: toNullableString(row.email),
    username: toNullableString(row.username),
    image: toNullableString(row.image),
    color: /** @type {ContactRow["color"]} */ (
      parseJsonOrFallback(row.color_json, null)
    ),
    lastSeen: toNullableString(row.last_seen),
    lastMessage,
    lastMessageAt,
    lastMessageMeta: {
      type: /** @type {"text" | "file" | "call"} */ (derivedType),
      deletedForEveryone: derivedDeleted,
      senderId: derivedSenderId,
    },
    unreadCount: toIntegerOrZero(row.unread_count),
    bootstrapStatus:
      typeof row.bootstrap_status === "string" ? row.bootstrap_status : "pending",
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {ChannelRow}
 */
function mapChannelRow(row) {
  const members = /** @type {string[]} */ (
    parseJsonOrFallback(row.members_json, [])
  );
  return {
    _id: String(row.channel_id),
    channelName: String(row.channel_name),
    admin: String(row.admin_user_id),
    members: Array.isArray(members) ? members : [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    bootstrapStatus:
      typeof row.bootstrap_status === "string" ? row.bootstrap_status : "pending",
  };
}

/**
 * @param {Record<string, unknown>} row
 * @returns {OutboundItem}
 */
function mapOutboundRow(row) {
  return {
    id: String(row.id),
    queueSeq: toIntegerOrZero(row.queue_seq),
    kind: /** @type {OutboundItem["kind"]} */ (row.kind),
    conversationId: String(row.conversation_id),
    conversationType: /** @type {ConversationType} */ (row.conversation_type),
    payloadJson:
      typeof row.payload_json === "string" ? row.payload_json : "{}",
    localFilePath: toNullableString(row.local_file_path),
    clientTempId: toNullableString(row.client_temp_id),
    attempts: toIntegerOrZero(row.attempts),
    nextAttemptAt: toNullableString(row.next_attempt_at),
    lastError: toNullableString(row.last_error),
    status: /** @type {OutboundItem["status"]} */ (row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err.slice(0, 200);
  if (err instanceof Error) return (err.message || err.name || "error").slice(0, 200);
  try {
    return String(err).slice(0, 200);
  } catch {
    return "unprintable";
  }
}

/**
 * Extract a user id from either a bare string or a populated `{ _id, ... }`
 * subdoc shape, mirroring the wireFormat helper but without depending on the
 * full serializer (which would also validate the rest of the payload).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function extractIdLike(value) {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const inner = /** @type {{ _id?: unknown }} */ (value)._id;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return null;
}

/**
 * No-op Filesystem fallback used when the Capacitor plugin is unavailable
 * (web build, jsdom tests, Node CI). Avoids per-call try/catch sprinkled
 * through the lifecycle code when there's nothing on disk to remove.
 */
const NOOP_FILESYSTEM = Object.freeze({
  /** @returns {Promise<void>} */
  rmdir: async () => undefined,
  /** @returns {Promise<void>} */
  mkdir: async () => undefined,
  /** @returns {Promise<{ size: number }>} */
  stat: async () => {
    throw new Error("filesystem unavailable");
  },
});

// ---------------------------------------------------------------------------
// Repository factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh repository instance. Tests should construct their own via
 * this factory; production code should prefer {@link getRepository}.
 *
 * @param {CreateRepositoryOptions} [options]
 */
export function createRepository(options = {}) {
  const driver = options.driver != null ? options.driver : getSqliteDriver();
  const encryption =
    options.encryption != null ? options.encryption : getEncryptionLayer();
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const migrate =
    typeof options.migrate === "function" ? options.migrate : applyPendingMigrations;
  const skipDriverOpen = options.skipDriverOpen === true;
  const isNativePlatform =
    typeof options.isNativePlatform === "function"
      ? options.isNativePlatform
      : () => Capacitor.isNativePlatform();
  const filesystem =
    options.filesystem != null
      ? options.filesystem
      : isNativePlatform()
        ? /** @type {NonNullable<CreateRepositoryOptions["filesystem"]>} */ (
            /** @type {unknown} */ (Filesystem)
          )
        : NOOP_FILESYSTEM;
  // Per-conversation FIFO mutex (§3.5 / Req 5.6 / Req 5.7). Each repository
  // instance gets its own chain so concurrent test suites never share a
  // lock — production code uses `getRepository()` which is itself a
  // module-level singleton, so the mutex is process-wide there.
  const mutex =
    options.mutex != null ? options.mutex : createPerConversationMutex();

  // ----- Mutable state ---------------------------------------------------

  /** @type {string | null} */
  let userId = null;
  let ready = false;
  /** @type {Promise<InitResult> | null} */
  let initInFlight = null;
  /** @type {Set<() => void>} */
  const rebootstrapListeners = new Set();
  /** @type {{ messages: number, mediaBudget: number, mediaAutoMax: number }} */
  let metaCache = {
    messages: DEFAULT_MESSAGES_RETENTION_MAX,
    mediaBudget: 1_073_741_824,
    mediaAutoMax: 26_214_400,
  };

  // ----- Pub/sub state (task 7.4 / Req 1.2 / Req 11.1) -------------------
  //
  // In-process pub/sub keyed by conversation id (for messages) and a single
  // global set for contacts and for channels. The repository emits to the
  // matching listeners after every committed write so the UI re-renders
  // through the existing `OfflineProvider` → `useAppStore` mirror without
  // the UI having to poll. Listener invocations are wrapped in try/catch
  // so a buggy subscriber never breaks the rest of the chain or the
  // surrounding write — we just log a `SUBSCRIBE_LISTENER_FAILED`
  // diagnostic and move on.

  /** @type {Map<string, Set<(msgs: LocalMessage[]) => void>>} */
  const messageListeners = new Map();
  /** @type {Set<(contacts: ContactRow[]) => void>} */
  const contactsListeners = new Set();
  /** @type {Set<(channels: ChannelRow[]) => void>} */
  const channelsListeners = new Set();

  // ----- Internal: read meta config (Req 1.7 / 8.5 / 8.7) ----------------

  /**
   * Refresh the cached configuration values from `meta`. Called once on
   * `init()` and again from `wipe()` so a wipe-then-reinit cycle picks up
   * any user-driven changes the (future) settings UI may have made.
   *
   * `messages_retention_max` is intentionally NOT seeded by
   * `001__init.sql` — when absent the repository falls back to
   * {@link DEFAULT_MESSAGES_RETENTION_MAX}. The seed-on-first-read behavior
   * keeps the bound configurable per device without having to bake every
   * possible default into the schema migration.
   */
  async function refreshMetaCache() {
    /** @type {{ key?: unknown, value?: unknown }[]} */
    const rows = await driver.query(
      "SELECT key, value FROM meta WHERE key IN " +
        "('messages_retention_max','media_budget_bytes','media_auto_download_max_bytes')",
    );
    /** @type {Record<string, string>} */
    const map = {};
    for (const row of rows) {
      if (typeof row.key === "string" && row.value != null) {
        map[row.key] = String(row.value);
      }
    }
    metaCache = {
      messages:
        map.messages_retention_max != null
          ? Math.max(1, parseInt(map.messages_retention_max, 10) || DEFAULT_MESSAGES_RETENTION_MAX)
          : DEFAULT_MESSAGES_RETENTION_MAX,
      mediaBudget:
        map.media_budget_bytes != null
          ? Math.max(0, parseInt(map.media_budget_bytes, 10) || 0)
          : 1_073_741_824,
      mediaAutoMax:
        map.media_auto_download_max_bytes != null
          ? Math.max(0, parseInt(map.media_auto_download_max_bytes, 10) || 0)
          : 26_214_400,
    };
  }

  /**
   * Upsert a single `meta` key. Used by lifecycle hooks (user_id,
   * local_encryption) where the seed migration may or may not have created
   * the row yet.
   *
   * @param {string} key
   * @param {string} value
   */
  async function setMeta(key, value) {
    await driver.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  /**
   * Read a single `meta` value. Returns `null` when the row is absent.
   *
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async function getMeta(key) {
    const rows = /** @type {{ value?: unknown }[]} */ (
      await driver.query("SELECT value FROM meta WHERE key = ? LIMIT 1", [key])
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const v = rows[0]?.value;
    return v == null ? null : String(v);
  }

  // ----- Internal: retention pruning (Req 1.7 / Property 3) -------------

  /**
   * Per-conversation retention pass. Keeps the most recent `max` rows for
   * `conversationId` and deletes the rest.
   *
   * Ordering rule (mirrors Property 3 verbatim): retain the rows with the
   * largest `created_at`; ties broken by `server_id` lexicographic order
   * (larger `server_id` wins). The "delete the oldest" inverse is therefore
   * `ORDER BY created_at ASC, server_id ASC`.
   *
   * Row equality semantics for ties: `server_id` is `NULL` while a message
   * is in the outbound queue (`syncState = 'local_only'`). SQLite's default
   * sort places `NULL` before non-`NULL` values when ASC, which means a
   * still-pending row with the same `created_at` as a confirmed row would
   * be evicted first. That is the desired behaviour — once the server
   * confirms the row its `server_id` populates and we keep the confirmed
   * version. Eviction of an unconfirmed row is rare in practice (retention
   * limit is 500 by default) and matches the intent of Req 1.7 / Property 3
   * to favor durably-confirmed history over transient state.
   *
   * The function is exposed so task 7.2 can call it from inside its commit
   * transaction: prune-on-commit keeps the size invariant tight without
   * scheduling a separate compaction pass.
   *
   * @param {string} conversationId
   * @param {{ max?: number, driver?: RepositoryDriver }} [opts]
   * @returns {Promise<{ deleted: number }>}
   */
  async function pruneRetention(conversationId, opts = {}) {
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return { deleted: 0 };
    }
    const max =
      typeof opts.max === "number" && Number.isFinite(opts.max) && opts.max >= 1
        ? Math.floor(opts.max)
        : metaCache.messages;
    // Allow the caller to pass a tx handle so this can run inside the same
    // transaction as the upsert (task 7.2). When omitted we issue the SQL
    // against the top-level driver, which auto-commits each statement.
    const exec = opts.driver != null ? opts.driver : driver;

    const countRows = /** @type {{ n?: unknown }[]} */ (
      await exec.query(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?",
        [conversationId],
      )
    );
    const total = toIntegerOrZero(countRows[0]?.n);
    if (total <= max) return { deleted: 0 };

    const overflow = total - max;
    // Two-step delete (sub-select by id) so the engine cannot trip on the
    // SQLite restriction against ORDER BY+LIMIT in a top-level DELETE.
    const result = await exec.run(
      "DELETE FROM messages WHERE id IN (" +
        "SELECT id FROM messages WHERE conversation_id = ? " +
        "ORDER BY created_at ASC, server_id ASC LIMIT ?" +
        ")",
      [conversationId, overflow],
    );
    return { deleted: toIntegerOrZero(result.changes) };
  }

  // ----- Lifecycle: init / isReady / wipe / clearAndRebootstrap ---------

  /**
   * Initialize the repository for `userId`. Idempotent: a second call with
   * the same user is a no-op; a call with a different user wipes local
   * data first (Req 1.6 / §Migration plan).
   *
   * The method never throws — it resolves to a typed result so the boot
   * path (`OfflineProvider`) can fall through to the existing online-only
   * flow when the offline layer is unavailable (Req 2.5).
   *
   * @param {{ userId: string }} args
   * @returns {Promise<InitResult>}
   */
  async function init(args) {
    if (args == null || typeof args.userId !== "string" || args.userId.length === 0) {
      return { ok: false, reason: "INVALID_USER_ID" };
    }
    if (ready && userId === args.userId) {
      return { ok: true };
    }
    if (initInFlight != null) {
      return initInFlight;
    }

    initInFlight = (async () => {
      const startedAt = Date.now();
      try {
        // 1. Encryption passphrase. Failures fall back to an unencrypted DB
        //    inside the app-private sandbox (Req 10.4) — `getOrCreatePassphrase`
        //    returns `{ mode: "none", passphrase: "" }` on every failure
        //    path and logs `ENCRYPTION_FALLBACK` itself.
        const enc = await encryption.getOrCreatePassphrase();

        // 2. Open the SQLite connection (skipped in tests that pre-open).
        if (!skipDriverOpen && typeof driver.open === "function") {
          const opened = await driver.open({
            dbName: DB_NAME,
            passphrase: enc.passphrase,
            readOnly: false,
          });
          if (opened.ok !== true) {
            diagnostics.log({
              category: "boot",
              code: "REPOSITORY_INIT_FAILED",
              outcome: "error",
              meta: { stage: "driver.open", reason: opened.reason },
            });
            return { ok: false, reason: opened.reason || "OPEN_FAILED" };
          }
        }

        // 3. Apply any pending migrations BEFORE we touch `meta` rows; the
        //    migrator is the one that creates the table on a fresh DB.
        const migrated = await migrate(driver, { dbName: DB_NAME });
        if (migrated.ok !== true) {
          diagnostics.log({
            category: "boot",
            code: "REPOSITORY_INIT_FAILED",
            outcome: "error",
            meta: {
              stage: "migrate",
              reason: migrated.reason,
              error: /** @type {{ error?: string }} */ (migrated).error,
            },
          });
          return {
            ok: false,
            reason: migrated.reason || "MIGRATION_FAILED",
          };
        }

        // 4. Persist the encryption mode so Diagnostics can report it
        //    (Req 14.2). A previous run may have used a different mode (key
        //    invalidation flipping us to "none", for example) — overwrite
        //    on every boot so the row reflects the actual state on disk.
        await setMeta("local_encryption", enc.mode === "secure" ? "secure" : "none");

        // 5. User-switch detection. If a different user previously occupied
        //    this DB, wipe their data before persisting the new user_id so
        //    we cannot leak content across sessions (§Migration plan).
        const persistedUserId = await getMeta("user_id");
        if (persistedUserId != null && persistedUserId !== args.userId) {
          diagnostics.log({
            category: "boot",
            code: "USER_SWITCH_DETECTED",
            outcome: "warn",
            meta: { previousUserId: persistedUserId, newUserId: args.userId },
          });
          await wipeInternal();
        }
        await setMeta("user_id", args.userId);

        // 6. Refresh the cached config values now that the schema is up to
        //    date and any wipe-induced reset has settled.
        await refreshMetaCache();

        userId = args.userId;
        ready = true;
        diagnostics.log({
          category: "boot",
          code: "REPOSITORY_READY",
          outcome: "ok",
          durationMs: Date.now() - startedAt,
          meta: { schemaVersion: CODE_VERSION, userId: args.userId },
        });
        return { ok: true };
      } catch (err) {
        diagnostics.log({
          category: "boot",
          code: "REPOSITORY_INIT_FAILED",
          outcome: "error",
          meta: { stage: "unhandled", reason: describeError(err) },
        });
        return { ok: false, reason: "INIT_FAILED" };
      } finally {
        initInFlight = null;
      }
    })();

    return initInFlight;
  }

  function isReady() {
    return ready;
  }

  /**
   * Internal wipe used by both `wipe()` and the user-switch branch of
   * `init()`. Keeps the side-effects ordered:
   *
   *   1. DELETE all user-data rows in a single transaction so a partial
   *      failure leaves the DB consistent.
   *   2. Reset the `next_queue_seq` counter so the new user starts from
   *      zero (Req 6.1 monotonic guarantee within a session).
   *   3. Drop the user-bound `meta.user_id` row so the next `init()` does
   *      not mistakenly think we are still bound to the previous user.
   *   4. Recursively remove the on-disk media directory (Req 1.6 / §3.7).
   */
  async function wipeInternal() {
    await driver.withTransaction(async (tx) => {
      // The single multi-statement exec is faster than 8 separate runs and
      // keeps the atomicity guarantee tight.
      await tx.exec(
        "DELETE FROM messages;" +
          "DELETE FROM channel_members;" +
          "DELETE FROM contacts;" +
          "DELETE FROM channels;" +
          "DELETE FROM users;" +
          "DELETE FROM outbound_queue;" +
          "DELETE FROM media_cache;" +
          "DELETE FROM sync_cursors;",
      );
      await tx.run(
        "INSERT INTO meta (key, value) VALUES ('next_queue_seq', '0') " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      await tx.run("DELETE FROM meta WHERE key = 'user_id'");
      // bootstrap_completed_at is user-bound — clearing it forces the
      // next init to run a fresh bootstrap pass (Req 1.6 / §Migration plan).
      await tx.run("DELETE FROM meta WHERE key = 'bootstrap_completed_at'");
      // last_incremental_sync_at is also user-bound; without a clear here
      // a wipe-then-reinit could resume incremental from a stale watermark.
      await tx.run(
        "DELETE FROM meta WHERE key = 'last_incremental_sync_at'",
      );
    });

    try {
      await filesystem.rmdir({
        path: MEDIA_DIRECTORY_PATH,
        directory: MEDIA_DIRECTORY,
        recursive: true,
      });
    } catch (err) {
      // The media directory may not exist yet (fresh install, or already
      // wiped). Treat any rmdir failure as non-fatal — Diagnostics records
      // it for support reports but the wipe itself has already cleared the
      // SQL rows that point at the files.
      diagnostics.log({
        category: "media",
        code: "MEDIA_WIPE_PARTIAL",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }
  }

  /**
   * Public wipe. Tears down all user data and the cached state, then marks
   * the repository as not-ready so the next `init()` runs the full
   * sequence (including encryption reset by the caller via
   * `EncryptionLayer.destroy()`).
   *
   * @returns {Promise<void>}
   */
  async function wipe() {
    const startedAt = Date.now();
    try {
      await wipeInternal();
      if (typeof driver.deleteDatabase === "function") {
        await driver.deleteDatabase(DB_NAME);
      }
      if (typeof driver.close === "function") {
        await driver.close();
      }
      userId = null;
      ready = false;
      diagnostics.log({
        category: "boot",
        code: "REPOSITORY_WIPED",
        outcome: "ok",
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "REPOSITORY_WIPE_FAILED",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
      throw err;
    }
  }

  /**
   * Drop the local DB contents and trigger `Bootstrap_Sync` (Req 3.5).
   *
   * In v1 we implement the "drop" as a wipe of every user-data row plus a
   * media-directory rmdir. The encryption key, schema version, and other
   * device-scoped metadata are intentionally preserved so the next sync
   * does not have to re-provision the secret store. Subscribers registered
   * via {@link onClearAndRebootstrap} (currently the SyncEngine, task 11)
   * are notified so they can re-issue `Bootstrap_Sync` for the active
   * user.
   *
   * Note: the design also describes an alternative implementation that
   * deletes the SQLite file outright via the plugin's `deleteDatabase`
   * call. We opted for the row-level wipe because it works identically
   * across the production driver and the `better-sqlite3` test driver and
   * because the plugin's file-delete API requires the connection to be
   * closed first, which would force the boot path to re-open and re-key.
   * Functionally the two approaches are equivalent for Req 3.5.
   *
   * @returns {Promise<void>}
   */
  async function clearAndRebootstrap() {
    const startedAt = Date.now();
    await wipeInternal();
    if (userId != null) {
      await setMeta("user_id", userId);
    }
    diagnostics.log({
      category: "boot",
      code: "REPOSITORY_CLEAR_AND_REBOOTSTRAP",
      outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    // Notify subscribers (e.g. SyncEngine) on the next microtask so they
    // observe the post-wipe state via `getContacts()` / `getChannels()`
    // returning empty arrays.
    rebootstrapListeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        diagnostics.log({
          category: "boot",
          code: "REBOOTSTRAP_LISTENER_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    });
  }

  /**
   * Register a callback invoked at the tail of `clearAndRebootstrap()`.
   * Returns an unsubscribe function. The SyncEngine wires `bootstrap()` in
   * here in task 11.x.
   *
   * @param {() => void} listener
   * @returns {() => void}
   */
  function onClearAndRebootstrap(listener) {
    if (typeof listener !== "function") return () => {};
    rebootstrapListeners.add(listener);
    return () => {
      rebootstrapListeners.delete(listener);
    };
  }

  // ----- Reads -----------------------------------------------------------

  /**
   * Throw a clear error when a read is issued before `init()` resolved.
   * Reads are cheap; failing fast here prevents confusing errors from the
   * driver layer ("connection is not open") leaking up to UI code.
   *
   * @param {string} method
   */
  function requireReady(method) {
    if (!ready) {
      throw new Error(
        `repository.${method}: repository is not initialized — call init() first`,
      );
    }
  }

  /**
   * Returns the cached contact list ordered by most-recent message first
   * (falling back to `updated_at` when no messages have arrived yet). Joins
   * `users` for the display fields so the UI does not have to issue a
   * second lookup per row.
   *
   * @returns {Promise<ContactRow[]>}
   */
  async function getContacts() {
    requireReady("getContacts");
    // `unread_count`, `last_message`, and `last_message_at` are all
    // derived on read from the `messages` table — the messages table is
    // the single source of truth. The columns on the `contacts` row are
    // kept as a COALESCE bootstrap hint for the cold-start window where
    // /dm-contacts has run but per-conversation messages have not yet
    // been hydrated locally; once any message exists, the messages
    // subquery wins.
    //
    // The previous design stored the preview text and sort timestamp as
    // denormalized columns on the `contacts` row. No message-write path
    // (enqueueOutbound / applyServerMessages / applyLiveMessage /
    // markOutboundConfirmed / applyStatusUpdate / applyDeletion)
    // updated that row, so after a send the home page sort and preview
    // stayed frozen on whatever the last server /dm-contacts sync said.
    // Deriving eliminates that bug class and matches the decision made
    // for `unread_count` in 77843b5.
    //
    // The last-message subquery uses idx_messages_conv_created
    // (conversation_id, created_at DESC) for a single index seek per
    // contact. The inner tiebreaker (server_id DESC with NULLs last via
    // the CASE expression) matches the one used by getMessages() so the
    // "latest message" definition is consistent everywhere.
    const rows = /** @type {Record<string, unknown>[]} */ (
      await driver.query(
        "SELECT c.user_id, " +
        "       c.last_message AS last_message_cached, " +
        "       c.last_message_at AS last_message_at_cached, " +
          "       lm.content              AS last_message_content, " +
          "       lm.message_type         AS last_message_type, " +
          "       lm.deleted_for_everyone AS last_deleted_for_everyone, " +
          "       lm.sender_id            AS last_message_sender_id, " +
          "       lm.created_at           AS last_message_created_at, " +
          "       COALESCE((SELECT COUNT(*) FROM messages m " +
          "                  WHERE m.conversation_id = c.user_id " +
          "                    AND m.conversation_type = 'dm' " +
          "                    AND m.sender_id = c.user_id " +
          "                    AND m.status != 'read' " +
          "                    AND m.deleted_for_me = 0), c.unread_count) AS unread_count, " +
          "       c.bootstrap_status, c.updated_at, " +
          "       u.first_name, u.last_name, u.email, u.username, " +
          "       u.image, u.color_json, u.last_seen " +
          "FROM contacts c " +
          "LEFT JOIN users u ON u.user_id = c.user_id " +
          "LEFT JOIN ( " +
          "  SELECT m.conversation_id, m.content, m.message_type, " +
          "         m.deleted_for_everyone, m.sender_id, m.created_at " +
          "  FROM messages m " +
          "  WHERE m.conversation_type = 'dm' " +
          "    AND m.deleted_for_me = 0 " +
          "    AND m.id = ( " +
          "      SELECT m2.id FROM messages m2 " +
          "      WHERE m2.conversation_id = m.conversation_id " +
          "        AND m2.conversation_type = 'dm' " +
          "        AND m2.deleted_for_me = 0 " +
          "      ORDER BY m2.created_at DESC, " +
          "               CASE WHEN m2.server_id IS NULL THEN m2.id ELSE m2.server_id END DESC " +
          "      LIMIT 1 " +
          "    ) " +
          ") lm ON lm.conversation_id = c.user_id " +
          "ORDER BY COALESCE(lm.created_at, c.last_message_at, c.updated_at) DESC",
      )
    );
    return rows.map(mapContactRow);
  }

  /** @returns {Promise<ChannelRow[]>} */
  async function getChannels() {
    requireReady("getChannels");
    const rows = /** @type {Record<string, unknown>[]} */ (
      await driver.query(
        "SELECT channel_id, channel_name, admin_user_id, members_json, " +
          "       created_at, updated_at, bootstrap_status " +
          "FROM channels " +
          "ORDER BY updated_at DESC",
      )
    );
    return rows.map(mapChannelRow);
  }

  /**
   * Page through messages for a conversation, newest-first. Filters out
   * `deleted_for_me` rows per §3.6 ("Delete-for-me is handled at the read
   * layer").
   *
   * @param {{ conversationId: string, conversationType: ConversationType, before?: string, limit?: number, includeDeletedForMe?: boolean }} args
   * @returns {Promise<LocalMessage[]>}
   */
  async function getMessages(args) {
    requireReady("getMessages");
    if (
      args == null ||
      typeof args.conversationId !== "string" ||
      args.conversationId.length === 0
    ) {
      return [];
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : 50;
    const where = ["conversation_id = ?"];
    if (!args.includeDeletedForMe) {
      where.push("deleted_for_me = 0");
    }
    /** @type {unknown[]} */
    const params = [args.conversationId];
    if (typeof args.before === "string" && args.before.length > 0) {
      where.push("created_at < ?");
      params.push(args.before);
    }
    params.push(limit);
    const rows = /** @type {Record<string, unknown>[]} */ (
      await driver.query(
        `SELECT * FROM messages WHERE ${where.join(" AND ")} ` +
          `ORDER BY created_at DESC, server_id DESC LIMIT ?`,
        params,
      )
    );
    return rows.map(mapMessageRow);
  }

  /**
   * Look up a single message by its local UUID id. Returns `null` when the
   * row is absent (the caller never has to distinguish 0-row results from
   * empty-string id mistakes — both come out as `null`).
   *
   * @param {string} id
   * @returns {Promise<LocalMessage | null>}
   */
  async function getMessageById(id) {
    requireReady("getMessageById");
    if (typeof id !== "string" || id.length === 0) return null;
    const rows = /** @type {Record<string, unknown>[]} */ (
      await driver.query("SELECT * FROM messages WHERE id = ? LIMIT 1", [id])
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return mapMessageRow(rows[0]);
  }

  /**
   * Return queue items in `queueSeq` order. Excludes `succeeded` rows
   * (which the queue compactor will prune); includes `failed` rows so the
   * UI can render retry affordances.
   *
   * @returns {Promise<OutboundItem[]>}
   */
  async function getOutboundQueue() {
    requireReady("getOutboundQueue");
    // Build the `IN (?, ?, ?)` placeholder list dynamically so this query
    // can grow alongside ACTIVE_OUTBOUND_STATUSES without an SQL edit.
    const placeholders = ACTIVE_OUTBOUND_STATUSES.map(() => "?").join(",");
    const rows = /** @type {Record<string, unknown>[]} */ (
      await driver.query(
        `SELECT * FROM outbound_queue WHERE status IN (${placeholders}) ORDER BY queue_seq ASC`,
        [...ACTIVE_OUTBOUND_STATUSES],
      )
    );
    return rows.map(mapOutboundRow);
  }

  /**
   * Look up the cached local path for a server file URL. Returns `null`
   * when the URL has not been downloaded yet, when a download is in
   * progress, or when a previous download failed.
   *
   * The MediaCache (task 13) is responsible for the disk-readability
   * check that Property 14 requires; this method only reports the
   * `media_cache` row state. Bumping `last_accessed_at` is also the
   * MediaCache's job (Req 8.4) — keeping it out of the read API lets
   * `getCachedMediaPath` stay a true read.
   *
   * @param {string} serverFileUrl
   * @returns {Promise<string | null>}
   */
  async function getCachedMediaPath(serverFileUrl) {
    requireReady("getCachedMediaPath");
    if (typeof serverFileUrl !== "string" || serverFileUrl.length === 0) {
      return null;
    }
    const rows = /** @type {{ local_file_path?: unknown, status?: unknown }[]} */ (
      await driver.query(
        "SELECT local_file_path, status FROM media_cache " +
          "WHERE server_file_url = ? LIMIT 1",
        [serverFileUrl],
      )
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (row.status !== "downloaded") return null;
    return toNullableString(row.local_file_path);
  }

  // ----- Diagnostics passthrough ----------------------------------------

  /**
   * Snapshot of the diagnostics ring buffer plus the four projections
   * sourced from `meta` and the live tables. Wired into the "Diagnostics"
   * settings screen by task 16.10.
   *
   * @returns {Promise<unknown>}
   */
  async function getDiagnosticsSnapshot() {
    if (typeof diagnostics.snapshot === "function") {
      return diagnostics.snapshot();
    }
    return null;
  }

  // ----- Writes (task 7.2) ----------------------------------------------

  /**
   * Internal implementation of {@link applyServerMessages}. Assumes the
   * caller already holds the conversation's mutex (acquired by the public
   * wrapper below). Splitting the body keeps the locking layer in one
   * spot — see §3.5 / Req 5.6.
   *
   * @param {{ conversationId: string, conversationType: ConversationType, messages: unknown[], sourceCursor?: { lastServerId?: string, lastUpdatedAt?: string, lastSyncedAt?: string } }} args
   * @returns {Promise<{ inserted: number, updated: number, ignored: number }>}
   */
  async function applyServerMessagesLocked(args) {
    requireReady("applyServerMessages");
    if (
      args == null ||
      typeof args.conversationId !== "string" ||
      args.conversationId.length === 0 ||
      (args.conversationType !== "dm" && args.conversationType !== "channel")
    ) {
      return { inserted: 0, updated: 0, ignored: 0 };
    }
    const messages = Array.isArray(args.messages) ? args.messages : [];
    if (messages.length === 0) return { inserted: 0, updated: 0, ignored: 0 };

    let inserted = 0;
    let updated = 0;
    let ignored = 0;
    let rejected = 0;
    /** @type {{ serverId: string, updatedAt: string } | null} */
    let watermark = null;

    const nowIso = new Date().toISOString();

    await driver.withTransaction(async (tx) => {
      // Auto-promote the DM peer into the `users` + `contacts` tables so
      // a message from a never-seen contact surfaces in the sidebar the
      // moment this batch commits — no waiting on the next
      // /api/users/dm-contacts poll. WhatsApp-grade behavior: a chat
      // thread appears the instant a message from that thread lands.
      //   - users row: lifted from the message's populated sender/receiver
      //     via findPeerDocInBatch, keyed by conversationId (= peer id).
      //     If the message only carries a bare id, a stub `users` row is
      //     created to satisfy the `contacts.user_id` FK — the sidebar
      //     row will have NULL name / image until the next dm-contacts
      //     poll fills them in.
      //   - contacts row: stub with bootstrap_status='pending'; the
      //     JOIN-derived columns in getContacts (last_message,
      //     last_message_at, unread_count) fill in from `messages` on
      //     read, so a stub is sufficient for first render. The next
      //     applyContacts call promotes bootstrap_status to 'ready'.
      if (args.conversationType === "dm" && args.conversationId.length > 0) {
        const peerDoc = findPeerDocInBatch(messages, args.conversationId);
        if (peerDoc != null) {
          await upsertUserRow(tx, peerDoc, nowIso);
        } else {
          await ensureUserStub(tx, args.conversationId, nowIso);
        }
        await tx.run(
          "INSERT INTO contacts (user_id, bootstrap_status, updated_at) " +
            "VALUES (?, 'pending', ?) " +
            "ON CONFLICT(user_id) DO NOTHING",
          [args.conversationId, nowIso],
        );
      }

      for (const m of messages) {
        const r = await resolveAndApply(tx, m, {
          conversationId: args.conversationId,
          conversationType: args.conversationType,
        });
        if (r.outcome === "inserted") inserted += 1;
        else if (r.outcome === "updated") updated += 1;
        else if (r.outcome === "merged") updated += 1;
        else if (r.outcome === "ignored") ignored += 1;
        else if (r.outcome === "rejected") {
          rejected += 1;
          // Diagnostics emit lives outside the transaction so a noisy
          // counterparty cannot blow up the buffer mid-commit; capture the
          // field name in `meta` for support reports.
          continue;
        }

        // Track the largest (createdAt, serverId) we accepted. We only
        // promote rows that the resolver actually wrote (insert / update /
        // merge); ignored and rejected rows do not move the cursor.
        if (
          r.outcome === "inserted" ||
          r.outcome === "updated" ||
          r.outcome === "merged"
        ) {
          const incoming = /** @type {{ _id?: unknown, createdAt?: unknown, updatedAt?: unknown }} */ (
            m == null || typeof m !== "object" ? {} : m
          );
          const sid = typeof incoming._id === "string" ? incoming._id : null;
          const uat =
            typeof incoming.updatedAt === "string" ? incoming.updatedAt : null;
          if (sid != null && uat != null) {
            if (
              watermark == null ||
              uat > watermark.updatedAt ||
              (uat === watermark.updatedAt && sid > watermark.serverId)
            ) {
              watermark = /** @type {{ serverId: string, updatedAt: string }} */ ({ serverId: sid, updatedAt: uat });
            }
          }
        }
      }

      // Advance the per-conversation sync cursor inside the same transaction.
      // Any caller-supplied `sourceCursor` represents what the SyncEngine
      // observed for THIS batch's request; we use it as the floor so that an
      // empty-ish batch (e.g. all `ignored`) still records that we asked the
      // backend for everything up to that timestamp.
      const supplied = args.sourceCursor || null;
      const finalUpdatedAt =
        watermark != null && (supplied == null || watermark.updatedAt > (supplied.lastUpdatedAt || ""))
          ? watermark.updatedAt
          : supplied != null && typeof supplied.lastUpdatedAt === "string"
            ? supplied.lastUpdatedAt
            : null;
      const finalServerId =
        watermark != null
          ? watermark.serverId
          : supplied != null && typeof supplied.lastServerId === "string"
            ? supplied.lastServerId
            : null;

      if (finalUpdatedAt != null) {
        await tx.run(
          `INSERT INTO sync_cursors (conversation_id, conversation_type, last_server_id, last_updated_at, last_synced_at)
             VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, conversation_type) DO UPDATE SET
             last_server_id  = CASE
                                  WHEN excluded.last_updated_at >= COALESCE(sync_cursors.last_updated_at, '')
                                  THEN excluded.last_server_id
                                  ELSE sync_cursors.last_server_id
                                END,
             last_updated_at = CASE
                                  WHEN excluded.last_updated_at >= COALESCE(sync_cursors.last_updated_at, '')
                                  THEN excluded.last_updated_at
                                  ELSE sync_cursors.last_updated_at
                                END,
             last_synced_at  = excluded.last_synced_at`,
          [
            args.conversationId,
            args.conversationType,
            finalServerId,
            finalUpdatedAt,
            new Date().toISOString(),
          ],
        );
      }

      // Prune retention inside the same transaction so a wipe-and-restart
      // mid-flight cannot leave the row count above the bound (Req 1.7).
      await pruneRetention(args.conversationId, { driver: tx });
    });

    if (rejected > 0) {
      diagnostics.log({
        category: "incremental",
        code: "WIRE_FORMAT_REJECTED",
        outcome: "warn",
        meta: {
          conversationId: args.conversationId,
          conversationType: args.conversationType,
          rejected,
        },
      });
    }
    // Notify subscribers AFTER the transaction has committed (Req 1.2 /
    // Req 11.1). Contacts may have new last_message_at / unread state on
    // a DM update; channels may have new last activity on a channel
    // update — emit the matching collection-level listener too. Listener
    // failures are isolated by `notifyListeners`.
    await emitMessages(args.conversationId);
    if (args.conversationType === "channel") {
      await emitChannels();
    } else {
      await emitContacts();
    }
    return { inserted, updated, ignored };
  }

  /**
   * Public, mutex-serialized entry point for {@link applyServerMessagesLocked}.
   *
   * Acquires the per-conversation lock keyed by `args.conversationId` so
   * an in-flight `Incremental_Sync` batch and a concurrent
   * {@link applyLiveMessage} for the same conversation cannot interleave
   * (§3.5 / Req 5.6 / Req 5.7 / Req 9.7). Cross-conversation work runs
   * unimpeded — each conversationId has its own chain.
   *
   * Argument shape validation lives in the locked body so that buggy input
   * (missing conversationId / wrong conversationType) takes the same
   * early-return path it always has, without holding a lock.
   *
   * @param {{ conversationId: string, conversationType: ConversationType, messages: unknown[], sourceCursor?: { lastServerId?: string, lastCreatedAt?: string, lastSyncedAt?: string } }} args
   * @returns {Promise<{ inserted: number, updated: number, ignored: number }>}
   */
  async function applyServerMessages(args) {
    const key =
      args != null && typeof args.conversationId === "string" && args.conversationId.length > 0
        ? args.conversationId
        : GLOBAL_MUTEX_KEY;
    return mutex.withLock(key, () => applyServerMessagesLocked(args));
  }

  // ----- Contact / channel writes (task 7.2 follow-up) -------------------
  //
  // The bootstrap (§3.3) and incremental (§3.3) passes both fetch the DM
  // contact list (`GET /api/users/dm-contacts`) and the channel list
  // (`GET /api/channels`). The repository must persist those rows so the
  // UI's `getContacts()` / `getChannels()` reads (and the corresponding
  // subscriptions) survive an offline restart — Req 1.1, Req 4.3.
  //
  // Both writers run under the GLOBAL_MUTEX_KEY since contacts and
  // channels are shared collections (no per-conversation key applies).
  // Errors on a single row are swallowed and logged; a malformed payload
  // for one contact must not stop us from upserting the rest.

  /**
   * Find the populated sender / receiver subdoc in a message batch whose
   * id matches `peerId`. Used by the DM auto-promotion paths in
   * `applyServerMessagesLocked` and `applyLiveMessageLocked` to lift
   * the peer's display fields (firstName, lastName, image, color,
   * lastSeen) into the `users` table the moment a message from a
   * never-seen peer lands — so the sidebar surfaces the new chat
   * thread without waiting for the next /api/users/dm-contacts poll.
   *
   * Returns `null` when the peer is referenced only by id (e.g. the
   * server didn't populate `sender` for that row) — the caller then
   * falls back to letting the next /api/users/dm-contacts call handle
   * the user-table write.
   *
   * @param {unknown[]} messages
   * @param {string} peerId
   * @returns {Record<string, unknown> | null}
   */
  function findPeerDocInBatch(messages, peerId) {
    if (!Array.isArray(messages)) return null;
    for (const m of messages) {
      if (m == null || typeof m !== "object") continue;
      const doc = /** @type {Record<string, unknown>} */ (m);
      const sender = doc.sender;
      if (
        sender != null &&
        typeof sender === "object" &&
        !Array.isArray(sender) &&
        extractIdLike(sender) === peerId
      ) {
        return /** @type {Record<string, unknown>} */ (sender);
      }
      const receiver = doc.receiver;
      if (
        receiver != null &&
        typeof receiver === "object" &&
        !Array.isArray(receiver) &&
        extractIdLike(receiver) === peerId
      ) {
        return /** @type {Record<string, unknown>} */ (receiver);
      }
    }
    return null;
  }

  /**
   * Ensure a `users` row exists for `userId` without overwriting any
   * existing display fields. Used by the DM auto-promotion paths as a
   * FK-satisfying stub when the incoming message payload only carries
   * a bare sender/receiver id (no populated object to lift fields from)
   * — the chat thread still surfaces in the sidebar with NULL name /
   * image, and the next /api/users/dm-contacts poll fills them in.
   *
   * `INSERT OR IGNORE` (not `INSERT OR REPLACE`) so a previously
   * populated row is never clobbered by the stub.
   *
   * @param {{ run: (sql: string, values?: unknown[]) => Promise<unknown> }} tx
   * @param {string} userId
   * @param {string} updatedAt
   * @returns {Promise<void>}
   */
  async function ensureUserStub(tx, userId, updatedAt) {
    await tx.run(
      "INSERT OR IGNORE INTO users (user_id, updated_at) VALUES (?, ?)",
      [userId, updatedAt],
    );
  }

  /**
   * Upsert a single user row. Used by the contact and channel writers
   * to keep the `users` table populated with display fields the UI joins
   * against (`getContacts()` LEFT JOINs `users`).
   *
   * @param {{ run: (sql: string, values?: unknown[]) => Promise<unknown> }} tx
   * @param {Record<string, unknown>} u
   * @param {string} updatedAt
   * @returns {Promise<void>}
   */
  async function upsertUserRow(tx, u, updatedAt) {
    const userIdRaw = extractIdLike(u);
    if (userIdRaw == null) return;
    const colorJson =
      u.color == null
        ? null
        : (() => {
            try {
              return JSON.stringify(u.color);
            } catch {
              return null;
            }
          })();
    await tx.run(
      "INSERT INTO users (user_id, first_name, last_name, email, username, image, color_json, last_seen, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET " +
        "  first_name = excluded.first_name, " +
        "  last_name  = excluded.last_name, " +
        "  email      = excluded.email, " +
        "  username   = excluded.username, " +
        "  image      = excluded.image, " +
        "  color_json = excluded.color_json, " +
        "  last_seen  = COALESCE(excluded.last_seen, users.last_seen), " +
        "  updated_at = excluded.updated_at",
      [
        userIdRaw,
        typeof u.firstName === "string" ? u.firstName : null,
        typeof u.lastName === "string" ? u.lastName : null,
        typeof u.email === "string" ? u.email : null,
        typeof u.username === "string" ? u.username : null,
        typeof u.image === "string" ? u.image : null,
        colorJson,
        typeof u.lastSeen === "string" ? u.lastSeen : null,
        updatedAt,
      ],
    );
  }

  /**
   * Upsert the DM contact list returned by `GET /api/users/dm-contacts`.
   * Each entry is the populated user doc plus the server-computed
   * `unreadCount` (kept as a best-effort cache) and `lastMessage` /
   * `lastMessageAt` (kept as a cold-start hint only).
   *
   * The repository owns the snake_case schema; this method is the only
   * place in the codebase that writes the `contacts` and `users` tables
   * for the DM list payload. Subscribers registered via
   * {@link subscribeContacts} fire after the transaction commits.
   *
   * `last_message` and `last_message_at` are written here purely as a
   * COALESCE fallback for the cold-start window where /dm-contacts has
   * run but per-conversation messages have not yet been hydrated
   * locally. The source of truth is the `messages` table — see
   * getContacts() and mapContactRow(). As soon as any message exists
   * for the conversation, the derived query wins and these columns are
   * no longer read.
   *
   * Internal — runs under the GLOBAL_MUTEX_KEY acquired by the public
   * {@link applyContacts} wrapper.
   *
   * @param {unknown[]} contacts
   * @returns {Promise<{ upserted: number, ignored: number }>}
   */
  async function applyContactsLocked(contacts) {
    requireReady("applyContacts");
    if (!Array.isArray(contacts)) {
      return { upserted: 0, ignored: 0 };
    }
    const updatedAt = new Date().toISOString();
    let upserted = 0;
    let ignored = 0;
    await driver.withTransaction(async (tx) => {
      for (const raw of contacts) {
        if (raw == null || typeof raw !== "object") {
          ignored += 1;
          continue;
        }
        const c = /** @type {Record<string, unknown>} */ (raw);
        const userIdRaw = extractIdLike(c);
        if (userIdRaw == null) {
          ignored += 1;
          continue;
        }
        try {
          await upsertUserRow(tx, c, updatedAt);
          const unread =
            typeof c.unreadCount === "number" && Number.isFinite(c.unreadCount)
              ? Math.max(0, Math.floor(c.unreadCount))
              : 0;
          const lastMessage =
            typeof c.lastMessage === "string" ? c.lastMessage : null;
          const lastMessageAt =
            typeof c.lastMessageAt === "string" ? c.lastMessageAt : null;
          await tx.run(
            "INSERT INTO contacts (user_id, last_message, last_message_at, unread_count, bootstrap_status, updated_at) " +
              "VALUES (?, ?, ?, ?, 'ready', ?) " +
              "ON CONFLICT(user_id) DO UPDATE SET " +
              // last_message / last_message_at are derived from the
              // messages table on read (see getContacts) — they are the
              // source of truth. The columns are only retained as a
              // COALESCE bootstrap hint for the cold-start window.
              "  last_message = excluded.last_message, " +
              "  last_message_at = excluded.last_message_at, " +
              // unread_count is derived on read from the messages table
              // (see getContacts). The column is preserved as a
              // best-effort cache for the cold-start case where the
              // messages table hasn't been populated yet — but never
              // overwritten from the server's stale value, since
              // confirm-read may not have round-tripped before
              // /dm-contacts was sampled.
              "  unread_count = contacts.unread_count, " +
              "  bootstrap_status = 'ready', " +
              "  updated_at = excluded.updated_at",
            [userIdRaw, lastMessage, lastMessageAt, unread, updatedAt],
          );
          upserted += 1;
        } catch (err) {
          ignored += 1;
          diagnostics.log({
            category: "bootstrap",
            code: "CONTACT_UPSERT_FAILED",
            outcome: "warn",
            meta: { userId: userIdRaw, reason: describeError(err) },
          });
        }
      }
    });
    await emitContacts();
    return { upserted, ignored };
  }

  /**
   * Public, mutex-serialized entry point for {@link applyContactsLocked}.
   *
   * @param {unknown[]} contacts
   * @returns {Promise<{ upserted: number, ignored: number }>}
   */
  async function applyContacts(contacts) {
    return mutex.withLock(GLOBAL_MUTEX_KEY, () =>
      applyContactsLocked(contacts),
    );
  }

  /**
   * Reset the unread count of a contact to 0 in the local database.
   * Emits the updated contact list to subscribers.
   *
   * @param {string} contactId
   * @returns {Promise<void>}
   */
  async function resetUnreadCountLocked(contactId) {
    requireReady("resetUnreadCount");
    if (typeof contactId !== "string" || contactId.length === 0) return;
    // Two writes inside a single transaction so getContacts (which now
    // derives unread_count from the messages table) and the column-
    // backed fallback stay consistent. Without flipping messages, the
    // derived count would still report a positive number even though
    // the column is 0 — and the next emitContacts would re-render the
    // badge.
    await driver.withTransaction(async (tx) => {
      await tx.run(
        "UPDATE contacts SET unread_count = 0 WHERE user_id = ?",
        [contactId],
      );
      // Mirror the server-side `updateMessageStatusToRead`: every DM
      // FROM `contactId` TO us, currently sent or delivered, becomes
      // read. Bump updated_at so a later wire-format comparison sees
      // the row as newer than any pre-read server payload.
      await tx.run(
        "UPDATE messages SET status = 'read', updated_at = ? " +
          "WHERE conversation_id = ? AND conversation_type = 'dm' " +
          "  AND sender_id = ? AND status IN ('sent','delivered')",
        [new Date().toISOString(), contactId, contactId],
      );
    });
    await emitContacts();
    // The chat view subscribes per-conversationId — emit the matching
    // bucket so an open chat repaints the status ticks immediately.
    await emitMessages(contactId);
  }

  async function resetUnreadCount(contactId) {
    return mutex.withLock(GLOBAL_MUTEX_KEY, () => resetUnreadCountLocked(contactId));
  }

  /**
   * Upsert the channel list returned by `GET /api/channels`. Members are
   * stored both as a JSON blob on the channel row (for fast read) and as
   * individual rows in `channel_members` (for member lookups). Members
   * are NOT joined back to `users` here — when the membership list
   * contains populated user docs we upsert those into `users` as well so
   * the join in `getChannels()` keeps working without a follow-up
   * incremental fetch.
   *
   * Internal — runs under the GLOBAL_MUTEX_KEY acquired by the public
   * {@link applyChannels} wrapper.
   *
   * @param {unknown[]} channels
   * @returns {Promise<{ upserted: number, ignored: number }>}
   */
  async function applyChannelsLocked(channels) {
    requireReady("applyChannels");
    if (!Array.isArray(channels)) {
      return { upserted: 0, ignored: 0 };
    }
    const updatedAt = new Date().toISOString();
    let upserted = 0;
    let ignored = 0;
    await driver.withTransaction(async (tx) => {
      for (const raw of channels) {
        if (raw == null || typeof raw !== "object") {
          ignored += 1;
          continue;
        }
        const ch = /** @type {Record<string, unknown>} */ (raw);
        const channelId = extractIdLike(ch);
        if (channelId == null) {
          ignored += 1;
          continue;
        }
        const channelName =
          typeof ch.channelName === "string" && ch.channelName.length > 0
            ? ch.channelName
            : null;
        const adminId = extractIdLike(ch.admin);
        if (channelName == null || adminId == null) {
          ignored += 1;
          continue;
        }
        const membersRaw = Array.isArray(ch.members) ? ch.members : [];
        /** @type {string[]} */
        const memberIds = [];
        for (const m of membersRaw) {
          const mid = extractIdLike(m);
          if (mid != null) memberIds.push(mid);
        }
        const createdAt =
          typeof ch.createdAt === "string" ? ch.createdAt : updatedAt;
        const channelUpdatedAt =
          typeof ch.updatedAt === "string" ? ch.updatedAt : updatedAt;
        try {
          // Upsert any populated user docs we received with the channel
          // payload — keeps the users table fresh for the member list.
          if (
            ch.admin !== null &&
            typeof ch.admin === "object" &&
            !Array.isArray(ch.admin)
          ) {
            await upsertUserRow(
              tx,
              /** @type {Record<string, unknown>} */ (ch.admin),
              updatedAt,
            );
          }
          for (const m of membersRaw) {
            if (m !== null && typeof m === "object" && !Array.isArray(m)) {
              await upsertUserRow(
                tx,
                /** @type {Record<string, unknown>} */ (m),
                updatedAt,
              );
            }
          }
          await tx.run(
            "INSERT INTO channels (channel_id, channel_name, admin_user_id, members_json, created_at, updated_at, bootstrap_status) " +
              "VALUES (?, ?, ?, ?, ?, ?, 'ready') " +
              "ON CONFLICT(channel_id) DO UPDATE SET " +
              "  channel_name     = excluded.channel_name, " +
              "  admin_user_id    = excluded.admin_user_id, " +
              "  members_json     = excluded.members_json, " +
              "  updated_at       = excluded.updated_at, " +
              "  bootstrap_status = 'ready'",
            [
              channelId,
              channelName,
              adminId,
              JSON.stringify(memberIds),
              createdAt,
              channelUpdatedAt,
            ],
          );
          // Replace the channel_members rows for this channel: cheap and
          // keeps the table honest when a member is removed server-side.
          await tx.run("DELETE FROM channel_members WHERE channel_id = ?", [
            channelId,
          ]);
          for (const mid of memberIds) {
            await tx.run(
              "INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)",
              [channelId, mid],
            );
          }
          upserted += 1;
        } catch (err) {
          ignored += 1;
          diagnostics.log({
            category: "bootstrap",
            code: "CHANNEL_UPSERT_FAILED",
            outcome: "warn",
            meta: { channelId, reason: describeError(err) },
          });
        }
      }
    });
    await emitChannels();
    return { upserted, ignored };
  }

  /**
   * Public, mutex-serialized entry point for {@link applyChannelsLocked}.
   *
   * @param {unknown[]} channels
   * @returns {Promise<{ upserted: number, ignored: number }>}
   */
  async function applyChannels(channels) {
    return mutex.withLock(GLOBAL_MUTEX_KEY, () =>
      applyChannelsLocked(channels),
    );
  }

  /**
   * Apply a single live socket message. Same conflict-resolution path as
   * {@link applyServerMessages} but always one row, and the cursor only
   * advances when the live event arrives in-order. We do NOT push the
   * cursor for every live event — the SyncEngine still owns the cursor
   * advance via incremental sync (Req 5.6).
   *
   * The conversationId/conversationType is derived from the server payload:
   *   - `channelId` set → channel
   *   - else → DM, conversationId is the contact id from the local user's
   *     POV. We need the `userId` of the local user to compute that. The
   *     repository tracks it via `init({ userId })`.
   *
   * Internal — runs under the conversation mutex acquired by the public
   * {@link applyLiveMessage} wrapper below.
   *
   * @param {unknown} serverMessage
   * @returns {Promise<void>}
   */
  async function applyLiveMessageLocked(serverMessage) {
    requireReady("applyLiveMessage");
    if (serverMessage == null || typeof serverMessage !== "object") return;
    const m = /** @type {Record<string, unknown>} */ (serverMessage);

    const ctx = deriveLiveConversationContext(m);
    if (ctx == null) {
      diagnostics.log({
        category: "live",
        code: "LIVE_MESSAGE_DROPPED",
        outcome: "warn",
        meta: { reason: "missing_conversation_id" },
      });
      return;
    }
    const { conversationId: conversationIdResolved, conversationType } = ctx;

    let rejectedField = null;
    await driver.withTransaction(async (tx) => {
      // Auto-promote the DM peer (socket path) so a message from a
      // never-seen contact surfaces in the sidebar immediately, without
      // waiting for the next /api/users/dm-contacts poll. See the
      // matching block in applyServerMessagesLocked for the full
      // rationale. ensureUserStub covers the case where the socket
      // payload only carries a bare sender id (no populated object) —
      // we still want the chat thread to surface, even with a NULL
      // name / image until the next dm-contacts poll fills it in.
      if (conversationType === "dm" && conversationIdResolved.length > 0) {
        const liveTs = new Date().toISOString();
        const peerDoc = findPeerDocInBatch([m], conversationIdResolved);
        if (peerDoc != null) {
          await upsertUserRow(tx, peerDoc, liveTs);
        } else {
          await ensureUserStub(tx, conversationIdResolved, liveTs);
        }
        await tx.run(
          "INSERT INTO contacts (user_id, bootstrap_status, updated_at) " +
            "VALUES (?, 'pending', ?) " +
            "ON CONFLICT(user_id) DO NOTHING",
          [conversationIdResolved, liveTs],
        );
      }

      const r = await resolveAndApply(tx, m, {
        conversationId: conversationIdResolved,
        conversationType,
      });
      if (r.outcome === "rejected") {
        rejectedField = r.error.field || r.error.kind;
      }
      // Prune retention on every commit (Req 1.7).
      await pruneRetention(conversationIdResolved, { driver: tx });
    });

    if (rejectedField != null) {
      diagnostics.log({
        category: "live",
        code: "WIRE_FORMAT_REJECTED",
        outcome: "warn",
        meta: { field: rejectedField },
      });
    }
    // Post-commit emit (Req 1.2 / Req 11.1). The conversation is known
    // from the derived context above; collection-level emits cover the
    // case where last_message_at / channel activity moved.
    await emitMessages(conversationIdResolved);
    if (conversationType === "channel") {
      await emitChannels();
    } else {
      await emitContacts();
    }
  }

  /**
   * Derive `(conversationId, conversationType)` from a server message
   * payload using the same rules `applyLiveMessageLocked` applies. Pulled
   * out so the public mutex wrapper below can compute the lock key
   * identically — locking on the wrong key would defeat Req 5.6.
   *
   * Returns `null` when the conversationId cannot be derived (the locked
   * body emits the `LIVE_MESSAGE_DROPPED` diagnostic in that case).
   *
   * @param {Record<string, unknown>} m
   * @returns {{ conversationId: string, conversationType: ConversationType } | null}
   */
  function deriveLiveConversationContext(m) {
    const channelId =
      typeof m.channelId === "string" && m.channelId.length > 0
        ? m.channelId
        : null;
    /** @type {ConversationType} */
    const conversationType = channelId != null ? "channel" : "dm";
    /** @type {string | null} */
    let conversationId = channelId;
    if (conversationId == null) {
      // For DMs the local conversationId is the OTHER party's user id. The
      // server payload's `sender` and `receiver` may be either a string or
      // a populated `{ _id }` subdoc — handle both. Falls back to the
      // sender id when the local userId is not yet bound (e.g. during
      // bootstrap before the OfflineProvider seeded `userId`).
      const senderId = extractIdLike(m.sender);
      const receiverId = extractIdLike(m.receiver);
      if (userId != null) {
        if (senderId === userId && receiverId != null) {
          conversationId = receiverId;
        } else if (receiverId === userId && senderId != null) {
          conversationId = senderId;
        } else {
          conversationId = receiverId != null ? receiverId : senderId;
        }
      } else {
        conversationId = receiverId != null ? receiverId : senderId;
      }
    }
    if (conversationId == null) return null;
    return { conversationId, conversationType };
  }

  /**
   * Public, mutex-serialized entry point for {@link applyLiveMessageLocked}.
   *
   * Derives the conversation key from the payload and acquires the
   * matching per-conversation lock so a live event and a concurrent
   * incremental batch for the same conversation cannot interleave
   * (§3.5 / Req 5.6 / Req 9.7). Payloads that fail derivation fall
   * through to the global lock — the locked body still emits the
   * `LIVE_MESSAGE_DROPPED` diagnostic and short-circuits without
   * touching the DB.
   *
   * @param {unknown} serverMessage
   * @returns {Promise<void>}
   */
  async function applyLiveMessage(serverMessage) {
    /** @type {string} */
    let key = GLOBAL_MUTEX_KEY;
    if (serverMessage != null && typeof serverMessage === "object") {
      const ctx = deriveLiveConversationContext(
        /** @type {Record<string, unknown>} */ (serverMessage),
      );
      if (ctx != null) key = ctx.conversationId;
    }
    return mutex.withLock(key, () => applyLiveMessageLocked(serverMessage));
  }

  /**
   * Apply a delete-for-everyone tombstone. Clears `content`, `file_url`,
   * `file_name`, sets `deleted_for_everyone = 1`, and bumps `updated_at`
   * to a timestamp strictly greater than the prior value (Req 9.4 /
   * Property 17).
   *
   * Acts on every row matching `server_id` (there is at most one due to
   * the unique index, but the query uses `WHERE` rather than a select-
   * then-update so a missing row is silently ignored).
   *
   * Internal — runs under the conversation mutex acquired by the public
   * {@link applyDeletion} wrapper below.
   *
   * @param {{ serverId: string, deletedForEveryone: boolean }} args
   * @returns {Promise<void>}
   */
  async function applyDeletionLocked(args) {
    requireReady("applyDeletion");
    if (
      args == null ||
      typeof args.serverId !== "string" ||
      args.serverId.length === 0
    ) {
      return;
    }
    // Read the current row first so we can compute a strictly-greater
    // updated_at (Property 17 demands strict increase). Using a fresh
    // ISO timestamp is usually enough, but two deletions in the same
    // millisecond could tie — bump by 1ms in that case.
    const existing = /** @type {{ updated_at?: unknown, conversation_id?: unknown }[]} */ (
      await driver.query(
        "SELECT updated_at, conversation_id FROM messages WHERE server_id = ? LIMIT 1",
        [args.serverId],
      )
    );
    if (!Array.isArray(existing) || existing.length === 0) return;

    const priorUpdatedAt =
      typeof existing[0].updated_at === "string" ? existing[0].updated_at : "";
    const conversationId =
      typeof existing[0].conversation_id === "string"
        ? existing[0].conversation_id
        : null;

    let nextUpdatedAt = new Date().toISOString();
    if (nextUpdatedAt <= priorUpdatedAt) {
      // Lexicographic comparison works on ISO 8601 strings. Bump by a
      // millisecond to guarantee strict increase even if the wall clock
      // returned an equal-or-older value.
      const priorMs = Date.parse(priorUpdatedAt);
      if (Number.isFinite(priorMs)) {
        nextUpdatedAt = new Date(priorMs + 1).toISOString();
      } else {
        // Fall back to appending ".001Z" — this is purely defensive; in
        // practice we only land here if the prior timestamp was malformed.
        nextUpdatedAt = `${priorUpdatedAt}.001Z`;
      }
    }

    await driver.withTransaction(async (tx) => {
      await tx.run(
        `UPDATE messages SET
           deleted_for_everyone = ?,
           content = NULL,
           file_url = NULL,
           file_name = NULL,
           updated_at = ?
         WHERE server_id = ?`,
        [args.deletedForEveryone ? 1 : 0, nextUpdatedAt, args.serverId],
      );
      if (conversationId != null) {
        await pruneRetention(conversationId, { driver: tx });
      }
    });
    // Post-commit emit (Req 1.2 / Req 11.1). We know the row's
    // conversation_id from the SELECT above; channel-vs-DM is unknown
    // here so emit both collection-level listeners — extra calls are
    // cheap and the listener never fires when its bucket is empty.
    if (conversationId != null) {
      await emitMessages(conversationId);
    }
    await emitContacts();
    await emitChannels();
  }

  /**
   * Public, mutex-serialized entry point for {@link applyDeletionLocked}.
   *
   * `applyDeletion` is called by the `message-deleted` socket dispatch
   * (§3.3), which only knows the `serverId` — not the `conversationId`.
   * To pick the right lock key we look up the message's conversation_id
   * BEFORE acquiring the lock. The conversation_id on a `messages` row is
   * immutable once written (the conflict resolver never changes it), so
   * reading it outside the lock is safe.
   *
   * Falls back to {@link GLOBAL_MUTEX_KEY} when the row is unknown
   * locally — the locked body is a no-op in that case (the SELECT inside
   * returns nothing) but we still acquire a lock to keep the contract
   * "every write goes through the mutex" honest.
   *
   * @param {{ serverId: string, deletedForEveryone: boolean }} args
   * @returns {Promise<void>}
   */
  async function applyDeletion(args) {
    /** @type {string} */
    let key = GLOBAL_MUTEX_KEY;
    if (
      ready &&
      args != null &&
      typeof args.serverId === "string" &&
      args.serverId.length > 0
    ) {
      try {
        const rows = /** @type {{ conversation_id?: unknown }[]} */ (
          await driver.query(
            "SELECT conversation_id FROM messages WHERE server_id = ? LIMIT 1",
            [args.serverId],
          )
        );
        if (
          Array.isArray(rows) &&
          rows.length > 0 &&
          typeof rows[0].conversation_id === "string" &&
          rows[0].conversation_id.length > 0
        ) {
          key = rows[0].conversation_id;
        }
      } catch {
        // Driver hiccup — fall back to the global key so the locked body
        // can still attempt the UPDATE and surface a real error to the
        // caller.
      }
    }
    return mutex.withLock(key, () => applyDeletionLocked(args));
  }

  /**
   * Apply an inbound `message-status-update` event for a DM conversation.
   *
   * The backend emits this event for every message in the conversation
   * sent by `fromUserId` once the receiver crosses the next lifecycle
   * threshold (`delivered` when the receiver comes online, `read` when
   * the receiver opens the conversation). The local update therefore
   * targets every confirmed message between `fromUserId` and the local
   * user that is currently at a strictly lower rank.
   *
   * Backwards moves are dropped with a `STATUS_BACKWARDS_IGNORED`
   * diagnostic (Req 7.6); the SQL `WHERE` clause filters them out so the
   * UPDATE only changes rows that are actually advancing.
   *
   * Internal — runs under the conversation mutex acquired by the public
   * {@link applyStatusUpdate} wrapper below.
   *
   * @param {{ conversationId: string, fromUserId: string, status: MessageStatus }} args
   * @returns {Promise<void>}
   */
  async function applyStatusUpdateLocked(args) {
    requireReady("applyStatusUpdate");
    if (
      args == null ||
      typeof args.conversationId !== "string" ||
      args.conversationId.length === 0 ||
      typeof args.fromUserId !== "string" ||
      args.fromUserId.length === 0 ||
      typeof args.status !== "string"
    ) {
      return;
    }

    const targetRank = STATUS_RANK[/** @type {keyof typeof STATUS_RANK} */ (args.status)];
    if (typeof targetRank !== "number") {
      diagnostics.log({
        category: "live",
        code: "STATUS_BACKWARDS_IGNORED",
        outcome: "warn",
        meta: {
          conversationId: args.conversationId,
          reason: "unknown_status",
          status: args.status,
        },
      });
      return;
    }

    // Pull every row sent by `fromUserId` in this conversation and partition
    // them in JS by what monotonicMaxStatus would decide. This is simpler
    // (and easier to reason about) than expressing the same logic in SQL,
    // and the row count per status update is small (one DM thread, recent
    // window). The two partitions are:
    //
    //   acceptIds  — current rank ≤ target, OR current status is 'failed'
    //                (sanctioned `failed → *` retry per Req 7.5).
    //   ignoreIds  — current rank > target AND current status ≠ 'failed'.
    //                These are backwards attempts (Req 7.6) — we leave the
    //                row alone and emit a single STATUS_BACKWARDS_IGNORED
    //                diagnostic that summarizes the count.
    const candidates = /** @type {{ id?: unknown, status?: unknown }[]} */ (
      await driver.query(
        `SELECT id, status FROM messages
           WHERE conversation_id = ?
             AND sender_id = ?
             AND status != ?`,
        [args.conversationId, args.fromUserId, args.status],
      )
    );

    /** @type {string[]} */
    const acceptIds = [];
    let backwardsCount = 0;
    for (const row of candidates) {
      const cur = typeof row.status === "string" ? row.status : "";
      const id = typeof row.id === "string" ? row.id : null;
      if (id == null) continue;
      const curRank = STATUS_RANK[/** @type {keyof typeof STATUS_RANK} */ (cur)];
      if (cur === "failed" || (typeof curRank === "number" && curRank <= targetRank)) {
        acceptIds.push(id);
      } else if (typeof curRank === "number" && curRank > targetRank) {
        backwardsCount += 1;
      }
    }

    if (backwardsCount > 0) {
      diagnostics.log({
        category: "live",
        code: "STATUS_BACKWARDS_IGNORED",
        outcome: "warn",
        meta: {
          conversationId: args.conversationId,
          fromUserId: args.fromUserId,
          attemptedStatus: args.status,
          ignoredRows: backwardsCount,
        },
      });
    }

    if (acceptIds.length === 0) {
      // Nothing to do. Skip the transaction so we don't churn the prune
      // pass for a no-op update.
      return;
    }

    const placeholders = acceptIds.map(() => "?").join(",");
    await driver.withTransaction(async (tx) => {
      await tx.run(
        `UPDATE messages SET
           status = ?,
           updated_at = ?
         WHERE id IN (${placeholders})`,
        [args.status, new Date().toISOString(), ...acceptIds],
      );
      await pruneRetention(args.conversationId, { driver: tx });
    });
    // Post-commit emit (Req 1.2 / Req 11.1). Status updates target a
    // single DM conversation per the §3.3 dispatch table; emit the
    // matching messages bucket and the contacts list (unread counts may
    // have shifted).
    await emitMessages(args.conversationId);
    await emitContacts();
  }

  /**
   * Public, mutex-serialized entry point for {@link applyStatusUpdateLocked}.
   *
   * Lock key is the DM `conversationId` so a status update and a concurrent
   * incremental batch for the same conversation cannot race
   * (§3.5 / Req 5.6 / Req 7.6).
   *
   * @param {{ conversationId: string, fromUserId: string, status: MessageStatus }} args
   * @returns {Promise<void>}
   */
  async function applyStatusUpdate(args) {
    const key =
      args != null &&
      typeof args.conversationId === "string" &&
      args.conversationId.length > 0
        ? args.conversationId
        : GLOBAL_MUTEX_KEY;
    return mutex.withLock(key, () => applyStatusUpdateLocked(args));
  }

  // ----- Outbound queue (task 10.1) --------------------------------------
  //
  // The drain loop / retry / connectivity wiring lives in
  // `frontend/src/offline/sync/OutboundQueue.js`. This section owns the
  // SQL-level write path: queueSeq allocation (Req 6.1), optimistic
  // `messages` row creation for `send_text` / `send_file` (Req 7.2),
  // confirmation merge against the conflict resolver (Req 6.4), and the
  // `failed` terminal state (Req 6.5).

  /** @type {ReadonlySet<string>} */
  const OUTBOUND_KINDS = new Set([
    "send_text",
    "send_file",
    "mark_read",
    "delete_for_me",
    "delete_for_everyone",
  ]);

  /**
   * Atomically bump `meta.next_queue_seq` and return the post-bump value
   * (Req 6.1 / §3.5). MUST be called inside a transaction so the seq
   * allocation and the row insert commit together.
   *
   * SQLite has no `RETURNING` on `UPDATE` in older versions, so we issue
   * the UPDATE then SELECT inside the same transaction. Because every
   * `enqueueOutbound` runs through the per-conversation mutex (or the
   * global one), no two callers can interleave between the UPDATE and
   * the SELECT — the read is always of the value we just wrote.
   *
   * @param {RepositoryDriver} tx
   * @returns {Promise<number>}
   */
  async function bumpQueueSeq(tx) {
    await tx.run(
      "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) " +
        "WHERE key = 'next_queue_seq'",
    );
    const rows = /** @type {{ value?: unknown }[]} */ (
      await tx.query(
        "SELECT value FROM meta WHERE key = 'next_queue_seq' LIMIT 1",
      )
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw Object.assign(new Error("META_NEXT_QUEUE_SEQ_MISSING"), {
        code: "META_NEXT_QUEUE_SEQ_MISSING",
      });
    }
    const seq = parseInt(String(rows[0].value), 10);
    if (!Number.isFinite(seq) || seq <= 0) {
      throw Object.assign(new Error("META_NEXT_QUEUE_SEQ_INVALID"), {
        code: "META_NEXT_QUEUE_SEQ_INVALID",
      });
    }
    return seq;
  }

  /**
   * Validate the `kind`-specific payload shape so we fail fast at enqueue
   * time rather than at drain time (the drain loop is harder to debug
   * because it runs in the background). The checks intentionally stay
   * minimal — the OutboundQueue does the rest of the kind-specific
   * dispatch / wire-format work.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} payload
   * @returns {string | null} error code on failure, `null` on success
   */
  function validateOutboundPayload(kind, payload) {
    if (kind === "send_text") {
      if (typeof payload.content !== "string" || payload.content.length === 0) {
        return "INVALID_PAYLOAD_CONTENT";
      }
      return null;
    }
    if (kind === "send_file") {
      // Either the file is already uploaded (payload.fileUrl present) or
      // the queue still has the local path (item.localFilePath). The
      // OutboundQueue uploads on drain when fileUrl is missing.
      const hasFileUrl =
        typeof payload.fileUrl === "string" && payload.fileUrl.length > 0;
      const hasLocalFile =
        typeof payload.localFilePath === "string" &&
        payload.localFilePath.length > 0;
      if (!hasFileUrl && !hasLocalFile) {
        return "INVALID_PAYLOAD_FILE";
      }
      return null;
    }
    if (kind === "mark_read") {
      if (typeof payload.senderId !== "string" || payload.senderId.length === 0) {
        return "INVALID_PAYLOAD_SENDER";
      }
      return null;
    }
    if (kind === "delete_for_me" || kind === "delete_for_everyone") {
      if (typeof payload.messageId !== "string" || payload.messageId.length === 0) {
        return "INVALID_PAYLOAD_MESSAGE_ID";
      }
      return null;
    }
    return "INVALID_KIND";
  }

  /**
   * Build the optimistic `messages` row payload for a `send_text` /
   * `send_file` enqueue. Returns the values array aligned with the column
   * list used in the INSERT below. The sender id is taken from the bound
   * `userId` — the OutboundQueue and MessageBar treat the local user as
   * the sender for these kinds.
   *
   * @param {string} localId
   * @param {string} clientTempId
   * @param {string} conversationId
   * @param {ConversationType} conversationType
   * @param {string} kind
   * @param {Record<string, unknown>} payload
   * @param {string | null} localFilePath
   * @param {number} queueSeq
   * @param {string} now
   * @returns {{ row: unknown[], localMessage: LocalMessage } | null}
   */
  function buildOptimisticMessageRow(
    localId,
    clientTempId,
    conversationId,
    conversationType,
    kind,
    payload,
    localFilePath,
    queueSeq,
    now,
  ) {
    if (userId == null) return null;
    const messageType = kind === "send_text" ? "text" : "file";
    const content =
      messageType === "text" && typeof payload.content === "string"
        ? payload.content
        : null;
    const fileUrl =
      typeof payload.fileUrl === "string" && payload.fileUrl.length > 0
        ? payload.fileUrl
        : null;
    const fileName =
      typeof payload.fileName === "string" && payload.fileName.length > 0
        ? payload.fileName
        : null;
    const fileMetadataJson =
      payload.fileMetadata == null ? "{}" : (() => {
        try {
          const out = JSON.stringify(payload.fileMetadata);
          return typeof out === "string" ? out : "{}";
        } catch {
          return "{}";
        }
      })();
    const replyToJson =
      payload.replyTo == null
        ? null
        : (() => {
            try {
              const out = JSON.stringify(payload.replyTo);
              return typeof out === "string" ? out : null;
            } catch {
              return null;
            }
          })();
    const receiverId =
      conversationType === "dm" ? conversationId : null;
    const channelId =
      conversationType === "channel" ? conversationId : null;

    /** @type {LocalMessage} */
    const localMessage = {
      id: localId,
      serverId: null,
      clientTempId,
      conversationId,
      conversationType,
      senderId: userId,
      receiverId,
      channelId,
      messageType: /** @type {LocalMessage["messageType"]} */ (messageType),
      content,
      fileUrl,
      fileName,
      fileMetadataJson,
      replyToJson,
      status: "pending",
      deletedForEveryone: 0,
      deletedForMe: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      syncState: "local_only",
      queueSeq,
      localFilePath,
    };

    const row = [
      localId,
      null, // server_id
      clientTempId,
      conversationId,
      conversationType,
      userId,
      receiverId,
      channelId,
      messageType,
      content,
      fileUrl,
      fileName,
      fileMetadataJson,
      replyToJson,
      "pending",
      0,
      0,
      null, // deleted_at
      now,
      now,
      "local_only",
      queueSeq,
      localFilePath,
    ];
    return { row, localMessage };
  }

  /**
   * Internal `enqueueOutbound`. Allocates `queueSeq`, inserts the
   * `outbound_queue` row, and — for `send_text` / `send_file` — also
   * inserts the optimistic `messages` row. All inside a single
   * transaction (Req 6.1).
   *
   * @param {{ kind: string, conversationId: string, conversationType: ConversationType, payload?: Record<string, unknown>, localFilePath?: string | null, clientTempId?: string }} args
   * @returns {Promise<{ id: string, queueSeq: number, clientTempId: string | null, localMessage?: LocalMessage }>}
   */
  async function enqueueOutboundLocked(args) {
    requireReady("enqueueOutbound");
    if (
      args == null ||
      typeof args.kind !== "string" ||
      !OUTBOUND_KINDS.has(args.kind)
    ) {
      throw Object.assign(new Error("INVALID_KIND"), { code: "INVALID_KIND" });
    }
    if (
      typeof args.conversationId !== "string" ||
      args.conversationId.length === 0
    ) {
      throw Object.assign(new Error("INVALID_CONVERSATION_ID"), {
        code: "INVALID_CONVERSATION_ID",
      });
    }
    if (args.conversationType !== "dm" && args.conversationType !== "channel") {
      throw Object.assign(new Error("INVALID_CONVERSATION_TYPE"), {
        code: "INVALID_CONVERSATION_TYPE",
      });
    }
    /** @type {Record<string, unknown>} */
    const payload =
      args.payload != null && typeof args.payload === "object" && !Array.isArray(args.payload)
        ? /** @type {Record<string, unknown>} */ (args.payload)
        : {};
    const validationError = validateOutboundPayload(args.kind, payload);
    if (validationError != null) {
      throw Object.assign(new Error(validationError), { code: validationError });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const isMessageKind = args.kind === "send_text" || args.kind === "send_file";
    const clientTempId =
      typeof args.clientTempId === "string" && args.clientTempId.length > 0
        ? args.clientTempId
        : isMessageKind
          ? uuidv4()
          : null;
    const localFilePath =
      typeof args.localFilePath === "string" && args.localFilePath.length > 0
        ? args.localFilePath
        : null;

    /** @type {{ id: string, queueSeq: number, clientTempId: string | null, localMessage?: LocalMessage }} */
    let result = { id, queueSeq: 0, clientTempId };

    await driver.withTransaction(async (tx) => {
      // 1. Allocate queueSeq atomically (Req 6.1 / §3.5).
      const queueSeq = await bumpQueueSeq(tx);
      result.queueSeq = queueSeq;

      // 2. Insert the optimistic `messages` row first for send_text /
      //    send_file (Req 7.2). The unique constraint on `client_temp_id`
      //    prevents duplicate optimistic rows from a buggy double-tap.
      /** @type {LocalMessage | undefined} */
      let optimisticLocal;
      if (isMessageKind && clientTempId != null) {
        const localId = uuidv4();
        const built = buildOptimisticMessageRow(
          localId,
          clientTempId,
          args.conversationId,
          args.conversationType,
          args.kind,
          payload,
          localFilePath,
          queueSeq,
          now,
        );
        if (built != null) {
          await tx.run(
            `INSERT INTO messages (
               id, server_id, client_temp_id, conversation_id, conversation_type,
               sender_id, receiver_id, channel_id, message_type,
               content, file_url, file_name, file_metadata_json, reply_to_json,
               status, deleted_for_everyone, deleted_for_me, deleted_at,
               created_at, updated_at, sync_state, queue_seq, local_file_path
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            built.row,
          );
          optimisticLocal = built.localMessage;
        }
      } else if (args.kind === "delete_for_me" && typeof payload.messageId === "string") {
        await tx.run(
          `UPDATE messages SET deleted_for_me = 1, updated_at = ? WHERE server_id = ? OR id = ? OR client_temp_id = ?`,
          [now, payload.messageId, payload.messageId, payload.messageId]
        );
      } else if (args.kind === "delete_for_everyone" && typeof payload.messageId === "string") {
        await tx.run(
          `UPDATE messages SET deleted_for_everyone = 1, content = NULL, file_url = NULL, file_name = NULL, updated_at = ? WHERE server_id = ? OR id = ? OR client_temp_id = ?`,
          [now, payload.messageId, payload.messageId, payload.messageId]
        );
      }

      // 3. Insert the queue row.
      await tx.run(
        `INSERT INTO outbound_queue (
           id, queue_seq, kind, conversation_id, conversation_type,
           payload_json, local_file_path, client_temp_id,
           attempts, next_attempt_at, last_error,
           status, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          queueSeq,
          args.kind,
          args.conversationId,
          args.conversationType,
          JSON.stringify(payload),
          localFilePath,
          clientTempId,
          0,
          null,
          null,
          "queued",
          now,
          now,
        ],
      );

      // 4. Prune retention so the optimistic row does not let the
      //    conversation balloon past the bound (Req 1.7).
      if (isMessageKind) {
        await pruneRetention(args.conversationId, { driver: tx });
      }

      if (optimisticLocal != null) {
        result.localMessage = optimisticLocal;
      }
    });

    diagnostics.log({
      category: "outbound",
      code: "OUTBOUND_ENQUEUED",
      outcome: "ok",
      meta: {
        kind: args.kind,
        queueSeq: result.queueSeq,
        conversationType: args.conversationType,
      },
    });

    // Post-commit emit so the optimistic row (or optimistic deletion) appears in the conversation
    // immediately (Req 6.2).
    if (isMessageKind || args.kind === "delete_for_me" || args.kind === "delete_for_everyone") {
      await emitMessages(args.conversationId);
      if (args.conversationType === "channel") {
        await emitChannels();
      } else {
        await emitContacts();
      }
    }

    return result;
  }

  /**
   * Internal `markOutboundConfirmed`. Updates the queue row to
   * `succeeded` and merges the server-confirmed message into the
   * optimistic local row by `clientTempId` via the conflict resolver.
   *
   * Req 6.4 / Property 8: the `clientTempId`-keyed merge guarantees we
   * end up with exactly one row for the message even when the server's
   * `receiveMessage` event arrives concurrently with this call.
   *
   * @param {{ queueId: string, serverMessage?: unknown }} args
   * @returns {Promise<void>}
   */
  async function markOutboundConfirmedLocked(args) {
    requireReady("markOutboundConfirmed");
    if (
      args == null ||
      typeof args.queueId !== "string" ||
      args.queueId.length === 0
    ) {
      return;
    }

    // Look up the queue row so we know the conversation context for the
    // resolver call. Fall back gracefully when the row is missing — the
    // OutboundQueue may have already pruned a `succeeded` row.
    const rows = /** @type {{ conversation_id?: unknown, conversation_type?: unknown, client_temp_id?: unknown, status?: unknown }[]} */ (
      await driver.query(
        "SELECT conversation_id, conversation_type, client_temp_id, status " +
          "FROM outbound_queue WHERE id = ? LIMIT 1",
        [args.queueId],
      )
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      diagnostics.log({
        category: "outbound",
        code: "OUTBOUND_CONFIRM_MISSING",
        outcome: "warn",
        meta: { queueId: args.queueId },
      });
      return;
    }
    const queueRow = rows[0];
    const conversationId =
      typeof queueRow.conversation_id === "string"
        ? queueRow.conversation_id
        : null;
    const conversationType =
      queueRow.conversation_type === "dm" || queueRow.conversation_type === "channel"
        ? /** @type {ConversationType} */ (queueRow.conversation_type)
        : null;
    const now = new Date().toISOString();

    await driver.withTransaction(async (tx) => {
      // 1. Mark the queue row as succeeded. The compactor (60s timer in
      //    OutboundQueue) prunes succeeded rows; we leave them in place
      //    here so a concurrent reader observes the terminal state.
      await tx.run(
        "UPDATE outbound_queue SET status = 'succeeded', updated_at = ?, " +
          "last_error = NULL WHERE id = ?",
        [now, args.queueId],
      );

      // 2. Merge the server payload via the conflict resolver. This is the
      //    same code path `applyServerMessages` uses, so the optimistic
      //    `messages` row is updated in place by `client_temp_id` (Req
      //    9.3 / Property 8).
      if (
        args.serverMessage != null &&
        typeof args.serverMessage === "object" &&
        conversationId != null &&
        conversationType != null
      ) {
        await resolveAndApply(tx, args.serverMessage, {
          conversationId,
          conversationType,
        });
        await pruneRetention(conversationId, { driver: tx });
      }
    });

    diagnostics.log({
      category: "outbound",
      code: "OUTBOUND_CONFIRMED",
      outcome: "ok",
      meta: { queueId: args.queueId },
    });

    if (conversationId != null) {
      await emitMessages(conversationId);
      if (conversationType === "channel") {
        await emitChannels();
      } else {
        await emitContacts();
      }
    }
  }

  /**
   * Internal `markOutboundFailed`. Sets the queue row to `failed` and
   * flips the bound optimistic message row's status to `failed` so the
   * UI can render the retry affordance (Req 6.5).
   *
   * @param {{ queueId: string, error?: unknown }} args
   * @returns {Promise<void>}
   */
  async function markOutboundFailedLocked(args) {
    requireReady("markOutboundFailed");
    if (
      args == null ||
      typeof args.queueId !== "string" ||
      args.queueId.length === 0
    ) {
      return;
    }
    const errorMessage =
      args.error == null ? null : describeError(args.error);
    const now = new Date().toISOString();

    /** @type {string | null} */
    let conversationId = null;
    /** @type {ConversationType | null} */
    let conversationType = null;

    await driver.withTransaction(async (tx) => {
      const rows = /** @type {{ conversation_id?: unknown, conversation_type?: unknown, client_temp_id?: unknown }[]} */ (
        await tx.query(
          "SELECT conversation_id, conversation_type, client_temp_id " +
            "FROM outbound_queue WHERE id = ? LIMIT 1",
          [args.queueId],
        )
      );
      if (!Array.isArray(rows) || rows.length === 0) return;
      const queueRow = rows[0];
      conversationId =
        typeof queueRow.conversation_id === "string"
          ? queueRow.conversation_id
          : null;
      conversationType =
        queueRow.conversation_type === "dm" ||
        queueRow.conversation_type === "channel"
          ? /** @type {ConversationType} */ (queueRow.conversation_type)
          : null;
      const clientTempId =
        typeof queueRow.client_temp_id === "string" && queueRow.client_temp_id.length > 0
          ? queueRow.client_temp_id
          : null;

      await tx.run(
        "UPDATE outbound_queue SET status = 'failed', " +
          "last_error = ?, updated_at = ? WHERE id = ?",
        [errorMessage, now, args.queueId],
      );

      // Flip the bound optimistic message row to `failed` so the UI can
      // surface the retry affordance (Req 6.5). We only do this for rows
      // that are still in `pending` — if the server actually delivered
      // the message after we gave up retrying (rare race), we keep the
      // confirmed status in place.
      if (clientTempId != null) {
        await tx.run(
          "UPDATE messages SET status = 'failed', updated_at = ? " +
            "WHERE client_temp_id = ? AND status = 'pending'",
          [now, clientTempId],
        );
      }
    });

    diagnostics.log({
      category: "outbound",
      code: "OUTBOUND_FAILED",
      outcome: "warn",
      meta: { queueId: args.queueId, reason: errorMessage || "unknown" },
    });

    if (conversationId != null) {
      await emitMessages(conversationId);
      if (conversationType === "channel") {
        await emitChannels();
      } else {
        await emitContacts();
      }
    }
  }

  /**
   * Public, mutex-serialized {@link enqueueOutboundLocked}.
   *
   * The conversation key is taken from `args.conversationId` when present
   * (the §3.4 outbound contract calls for it on every kind), and falls
   * back to {@link GLOBAL_MUTEX_KEY} for the queue-head operations that do
   * not belong to any one conversation.
   *
   * @param {{ kind?: string, conversationId?: string, conversationType?: ConversationType, payload?: Record<string, unknown>, localFilePath?: string | null, clientTempId?: string }} [args]
   * @returns {Promise<{ id: string, queueSeq: number, clientTempId: string | null, localMessage?: LocalMessage }>}
   */
  function enqueueOutbound(args) {
    const key =
      args != null &&
      typeof args.conversationId === "string" &&
      args.conversationId.length > 0
        ? args.conversationId
        : GLOBAL_MUTEX_KEY;
    return mutex.withLock(key, () =>
      /** @type {Promise<{ id: string, queueSeq: number, clientTempId: string | null, localMessage?: LocalMessage }>} */ (
        enqueueOutboundLocked(/** @type {any} */ (args))
      ),
    );
  }

  /**
   * Public, mutex-serialized {@link markOutboundConfirmedLocked}.
   *
   * Looks up the queue row's `conversation_id` BEFORE acquiring the lock
   * so the lock key matches every other write for that conversation. The
   * row may be absent (e.g. if the OutboundQueue's compactor pruned a
   * succeeded entry); in that case we fall back to the global lock and
   * the locked body becomes a no-op.
   *
   * @param {{ queueId?: string, serverMessage?: unknown }} [args]
   * @returns {Promise<void>}
   */
  async function markOutboundConfirmed(args) {
    /** @type {string} */
    let key = GLOBAL_MUTEX_KEY;
    if (
      ready &&
      args != null &&
      typeof args.queueId === "string" &&
      args.queueId.length > 0
    ) {
      try {
        const rows = /** @type {{ conversation_id?: unknown }[]} */ (
          await driver.query(
            "SELECT conversation_id FROM outbound_queue WHERE id = ? LIMIT 1",
            [args.queueId],
          )
        );
        if (
          Array.isArray(rows) &&
          rows.length > 0 &&
          typeof rows[0].conversation_id === "string" &&
          rows[0].conversation_id.length > 0
        ) {
          key = rows[0].conversation_id;
        }
      } catch {
        // Driver hiccup — fall through to the global key so the locked
        // body still runs and surfaces a real error.
      }
    }
    return mutex.withLock(key, () =>
      markOutboundConfirmedLocked(/** @type {any} */ (args)),
    );
  }

  /**
   * Public, mutex-serialized {@link markOutboundFailedLocked}.
   *
   * Same conversationId lookup pattern as {@link markOutboundConfirmed}.
   *
   * @param {{ queueId?: string, error?: unknown }} [args]
   * @returns {Promise<void>}
   */
  async function markOutboundFailed(args) {
    /** @type {string} */
    let key = GLOBAL_MUTEX_KEY;
    if (
      ready &&
      args != null &&
      typeof args.queueId === "string" &&
      args.queueId.length > 0
    ) {
      try {
        const rows = /** @type {{ conversation_id?: unknown }[]} */ (
          await driver.query(
            "SELECT conversation_id FROM outbound_queue WHERE id = ? LIMIT 1",
            [args.queueId],
          )
        );
        if (
          Array.isArray(rows) &&
          rows.length > 0 &&
          typeof rows[0].conversation_id === "string" &&
          rows[0].conversation_id.length > 0
        ) {
          key = rows[0].conversation_id;
        }
      } catch {
        // Driver hiccup — fall through to the global key.
      }
    }
    return mutex.withLock(key, () =>
      markOutboundFailedLocked(/** @type {any} */ (args)),
    );
  }

  // Subscriptions — §3.1 contract / Req 1.2 / Req 11.1.
  //
  // Each subscribe* method registers the listener, returns a sync
  // `unsubscribe` that pulls the listener out of the registry, and is
  // safe to call repeatedly. The repository emits via `emitMessages` /
  // `emitContacts` / `emitChannels` after every committed write — see
  // the writes section above for the call sites.
  //
  // Listener invocations are isolated with try/catch (per the
  // `notifyListeners` helper) so that a subscriber throwing does not
  // break sibling listeners or the surrounding write.

  /**
   * Register a listener for messages in `conversationId`. Returns a
   * sync unsubscribe.
   *
   * Empty / non-string conversation ids and non-function listeners are
   * accepted as no-ops so call sites in React `useEffect` blocks can
   * unconditionally subscribe without guarding for the not-yet-loaded
   * conversation case.
   *
   * @param {string} conversationId
   * @param {(msgs: LocalMessage[]) => void} listener
   * @returns {() => void}
   */
  function subscribeMessages(conversationId, listener) {
    if (
      typeof conversationId !== "string" ||
      conversationId.length === 0 ||
      typeof listener !== "function"
    ) {
      return () => {};
    }
    let bucket = messageListeners.get(conversationId);
    if (bucket == null) {
      bucket = new Set();
      messageListeners.set(conversationId, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = messageListeners.get(conversationId);
      if (current == null) return;
      current.delete(listener);
      if (current.size === 0) messageListeners.delete(conversationId);
    };
  }

  /**
   * Register a listener for the contacts list. Single global bucket — every
   * registered listener fires whenever a write touches contacts state.
   *
   * @param {(contacts: ContactRow[]) => void} listener
   * @returns {() => void}
   */
  function subscribeContacts(listener) {
    if (typeof listener !== "function") return () => {};
    contactsListeners.add(listener);
    return () => {
      contactsListeners.delete(listener);
    };
  }

  /**
   * Register a listener for the channels list. Single global bucket —
   * every registered listener fires whenever a write touches channel state.
   *
   * @param {(channels: ChannelRow[]) => void} listener
   * @returns {() => void}
   */
  function subscribeChannels(listener) {
    if (typeof listener !== "function") return () => {};
    channelsListeners.add(listener);
    return () => {
      channelsListeners.delete(listener);
    };
  }

  /**
   * Dispatch a payload to every listener in `bucket`. Each call is wrapped
   * in try/catch — a thrown listener emits a `SUBSCRIBE_LISTENER_FAILED`
   * diagnostic and the loop continues, so one buggy consumer never blocks
   * the next.
   *
   * The bucket is snapshotted into an array before iteration so that a
   * listener which unsubscribes itself or a sibling during dispatch
   * cannot perturb the iteration order. Listeners that subscribe DURING
   * dispatch are picked up on the next emit, not the current one — this
   * matches the standard "stable subscriber set per emit" expectation
   * the React-style consumers rely on.
   *
   * @template T
   * @param {Iterable<(value: T) => void>} bucket
   * @param {T} payload
   * @param {string} channel
   */
  function notifyListeners(bucket, payload, channel) {
    const snapshotListeners = Array.from(bucket);
    for (const fn of snapshotListeners) {
      try {
        fn(payload);
      } catch (err) {
        diagnostics.log({
          category: "subscribe",
          code: "SUBSCRIBE_LISTENER_FAILED",
          outcome: "warn",
          meta: { channel, reason: describeError(err) },
        });
      }
    }
  }

  /**
   * Emit the latest message rows for `conversationId` to every registered
   * listener. Re-queries the DB (newest-first, paginated by the repository's
   * default page size) so the listener sees post-commit state. Called from
   * the public write wrappers AFTER the underlying transaction commits — so
   * even if a listener triggers another read it observes the durable state.
   *
   * Failures during the re-query are swallowed (logged) so an emit cannot
   * propagate up into the write code path.
   *
   * @param {string | null} conversationId
   * @returns {Promise<void>}
   */
  async function emitMessages(conversationId) {
    if (
      typeof conversationId !== "string" ||
      conversationId.length === 0 ||
      !ready
    ) {
      return;
    }
    const bucket = messageListeners.get(conversationId);
    if (bucket == null || bucket.size === 0) return;

    /** @type {LocalMessage[]} */
    let rows;
    try {
      // Use the same default page size and ordering the UI sees on the
      // initial load. Subscribers can re-paginate via `getMessages` for
      // older history; the live emit always carries the newest window.
      rows = await getMessages({
        conversationId,
        includeDeletedForMe: true,
        // conversationType is informational only inside getMessages — the
        // SQL filters by conversationId. Pass the type the row map will
        // surface in the result, defaulting to "dm".
        conversationType: "dm",
      });
    } catch (err) {
      diagnostics.log({
        category: "subscribe",
        code: "SUBSCRIBE_QUERY_FAILED",
        outcome: "warn",
        meta: {
          channel: "messages",
          conversationId,
          reason: describeError(err),
        },
      });
      return;
    }
    notifyListeners(bucket, rows, "messages");
  }

  /**
   * Emit the latest contact list to every registered contacts listener.
   * Same try/catch shape as {@link emitMessages}.
   *
   * @returns {Promise<void>}
   */
  async function emitContacts() {
    if (!ready || contactsListeners.size === 0) return;
    /** @type {ContactRow[]} */
    let rows;
    try {
      rows = await getContacts();
    } catch (err) {
      diagnostics.log({
        category: "subscribe",
        code: "SUBSCRIBE_QUERY_FAILED",
        outcome: "warn",
        meta: { channel: "contacts", reason: describeError(err) },
      });
      return;
    }
    notifyListeners(contactsListeners, rows, "contacts");
  }

  /**
   * Emit the latest channel list to every registered channels listener.
   *
   * @returns {Promise<void>}
   */
  async function emitChannels() {
    if (!ready || channelsListeners.size === 0) return;
    /** @type {ChannelRow[]} */
    let rows;
    try {
      rows = await getChannels();
    } catch (err) {
      diagnostics.log({
        category: "subscribe",
        code: "SUBSCRIBE_QUERY_FAILED",
        outcome: "warn",
        meta: { channel: "channels", reason: describeError(err) },
      });
      return;
    }
    notifyListeners(channelsListeners, rows, "channels");
  }

  // ----- Exposed surface -------------------------------------------------

  return {
    // lifecycle
    init,
    isReady,
    wipe,
    clearAndRebootstrap,
    onClearAndRebootstrap,

    // reads
    getContacts,
    getChannels,
    getMessages,
    getMessageById,
    getOutboundQueue,
    getCachedMediaPath,

    // writes (task 7.2)
    applyServerMessages,
    applyLiveMessage,
    applyDeletion,
    applyStatusUpdate,
    applyContacts,
    applyChannels,
    resetUnreadCount,

    // outbound queue (task 10.1)
    enqueueOutbound,
    markOutboundConfirmed,
    markOutboundFailed,

    // subscriptions (task 7.4)
    subscribeMessages,
    subscribeContacts,
    subscribeChannels,

    // diagnostics
    getDiagnosticsSnapshot,

    // retention pruning helper, used by task 7.2 inside its commit tx
    pruneRetention,

    // internal-ish accessors used by tests and the OfflineProvider
    getCurrentUserId: () => userId,
    getDriver: () => driver,
    getMutex: () => mutex,
  };
}

// ---------------------------------------------------------------------------
// Default singleton convenience surface
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createRepository> | null} */
let singleton = null;

/**
 * Process-wide repository used by `OfflineProvider`, `MessageContainer`,
 * `ContactContainer`, `MessageBar`, and the Sync_Engine. Tests must use
 * {@link createRepository} directly with their own driver / encryption /
 * filesystem stubs.
 *
 * @returns {ReturnType<typeof createRepository>}
 */
export function getRepository() {
  if (singleton == null) {
    singleton = createRepository();
  }
  return singleton;
}

/**
 * Reset the module-level singleton. Exported strictly for test setup; the
 * production boot path never calls this.
 *
 * @internal
 */
export function __resetRepositorySingletonForTests() {
  singleton = null;
}
