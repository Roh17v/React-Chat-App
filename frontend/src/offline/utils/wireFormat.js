// @ts-check
/**
 * Wire-format serializer / deserializer.
 *
 * Pure module: no SQLite, no DOM, no Capacitor plugins, no I/O. All public
 * functions return a `Result` and never throw, so they are safe to call from
 * arbitrary code paths (sync engine, repository, live-event handlers,
 * property tests).
 *
 * Implements §3.6 (Wire-format serializer) of the offline-support design.
 * Validates Requirements 12.1, 12.2, 12.4, 12.5; the round-trip property
 * 12.3 is exercised by `wireFormat.property.test.js` (Property 18).
 *
 * @module offline/utils/wireFormat
 */

// ---------------------------------------------------------------------------
// Result helper
// ---------------------------------------------------------------------------

/**
 * @template T, E
 * @typedef {{ ok: true, value: T } | { ok: false, error: E }} Result
 */

/**
 * @typedef {{ kind: "MISSING_FIELD", field: string }} WireFormatError
 */

/**
 * @template T
 * @param {T} value
 * @returns {{ ok: true, value: T }}
 */
const ok = (value) => ({ ok: true, value });

/**
 * @param {string} field
 * @returns {{ ok: false, error: WireFormatError }}
 */
const missing = (field) => ({
  ok: false,
  error: { kind: "MISSING_FIELD", field },
});

// ---------------------------------------------------------------------------
// Type definitions (informational only — the project is JS + JSDoc, no .d.ts)
// ---------------------------------------------------------------------------

/**
 * Server message payload, as received from the backend (`GET /api/messages/...`,
 * socket `receiveMessage`, etc.). Fields not listed here are silently
 * tolerated and ignored (Req 12.4).
 *
 * @typedef {Object} ServerMessage
 * @property {string} _id
 * @property {string | { _id: string, [k: string]: unknown }} sender
 * @property {string | { _id: string, [k: string]: unknown } | null} [receiver]
 * @property {"text" | "file" | "call"} messageType
 * @property {string | null} [content]
 * @property {string | null} [fileUrl]
 * @property {string | null} [fileName]
 * @property {Record<string, unknown> | null} [fileMetadata]
 * @property {object | null} [replyTo]
 * @property {"pending" | "sent" | "delivered" | "read" | "failed"} [status]
 * @property {string | null} [channelId]
 * @property {boolean} [deletedForEveryone]
 * @property {string | null} [deletedAt]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} [clientTempId]
 */

/**
 * Local DB row shape, in JS (camelCase). The repository layer is responsible
 * for translating between this shape and the SQLite snake_case columns.
 *
 * `toLocalRow` only fills in the message-level fields; the repository sets
 * `id`, `conversationId`, and `conversationType` from the surrounding context
 * (the server message alone does not carry the local user's POV).
 *
 * @typedef {Object} LocalMessage
 * @property {string} serverId
 * @property {string | null} clientTempId
 * @property {string} senderId
 * @property {string | null} receiverId
 * @property {string | null} channelId
 * @property {"text" | "file" | "call"} messageType
 * @property {string | null} content
 * @property {string | null} fileUrl
 * @property {string | null} fileName
 * @property {string} fileMetadataJson  Always a JSON-encoded string; defaults to "{}"
 * @property {string | null} replyToJson Either JSON-encoded string or null
 * @property {"pending" | "sent" | "delivered" | "read" | "failed"} status
 * @property {boolean} deletedForEveryone
 * @property {string | null} deletedAt
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {"local_only" | "confirmed" | "tombstoned"} syncState
 * @property {number | null} queueSeq
 * @property {string | null} localFilePath
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Extract a user id from either a bare string or a populated `{ _id, ... }`
 * subdoc shape. Returns `null` for any unrecognized form (including
 * undefined, null, empty string, non-string `_id`).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
const extractId = (value) => {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (isPlainObject(value)) {
    const inner = /** @type {{ _id?: unknown }} */ (value)._id;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return null;
};

/**
 * Optional non-empty string accessor. Returns the string if it's a non-empty
 * string, otherwise `null`. Treats `undefined`, `null`, and `""` uniformly.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
const optString = (value) =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Stable JSON.stringify wrapper that survives circular refs / odd values by
 * returning `"{}"` (the documented default for `fileMetadata`). Production
 * server payloads are JSON-typed, so the fallback is defensive only.
 *
 * @param {unknown} value
 * @returns {string}
 */
const stringifyOrDefault = (value) => {
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : "{}";
  } catch {
    return "{}";
  }
};

/**
 * @param {string | null | undefined} json
 * @param {unknown} fallback
 * @returns {unknown}
 */
const parseOrFallback = (json, fallback) => {
  if (json == null || json === "") return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// toLocalRow
// ---------------------------------------------------------------------------

/**
 * Convert a server message payload to a `Local_Database` row shape.
 *
 * - Ignores unknown top-level fields (Req 12.4).
 * - Normalizes `sender` and `receiver` from either a bare id string or a
 *   populated `{ _id, ... }` subdoc into a plain id string.
 * - Serializes `fileMetadata` to JSON (defaulting to `"{}"` when absent or
 *   nullish).
 * - Serializes `replyTo` to JSON, preserving `null` when absent.
 * - Marks the row as confirmed by the server (`syncState = "confirmed"`,
 *   `queueSeq = null`, `localFilePath = null`); these are local-only fields
 *   that the caller (repository) may overwrite for outbound queue items.
 * - Returns a typed error result without throwing if any required field is
 *   missing (Req 12.5).
 *
 * Required fields (Req 1.3):
 *   - Always: `_id`, `sender`, `messageType`, `createdAt`, `updatedAt`.
 *   - For `messageType === "text"`: `content`.
 *   - For `messageType === "file"`: `fileUrl`.
 *
 * @param {unknown} m
 * @returns {Result<LocalMessage, WireFormatError>}
 */
export function toLocalRow(m) {
  if (!isPlainObject(m)) return missing("_id");

  // --- Required fields (always) --------------------------------------------
  const serverId = optString(m._id);
  if (serverId === null) return missing("_id");

  const senderId = extractId(m.sender);
  if (senderId === null) return missing("sender");

  const messageType = m.messageType;
  if (
    messageType !== "text" &&
    messageType !== "file" &&
    messageType !== "call"
  ) {
    return missing("messageType");
  }

  const createdAt = optString(m.createdAt);
  if (createdAt === null) return missing("createdAt");

  const updatedAt = optString(m.updatedAt);
  if (updatedAt === null) return missing("updatedAt");

  // --- Required fields (per messageType) -----------------------------------
  // `content` for text MAY be the empty string in principle, so we only
  // reject `undefined`/`null`/non-string here.
  let content = null;
  if (messageType === "text") {
    if (typeof m.content !== "string") return missing("content");
    content = m.content;
  } else if (typeof m.content === "string") {
    content = m.content;
  }

  let fileUrl = null;
  if (messageType === "file") {
    if (typeof m.fileUrl !== "string" || m.fileUrl.length === 0) {
      return missing("fileUrl");
    }
    fileUrl = m.fileUrl;
  } else if (typeof m.fileUrl === "string") {
    fileUrl = m.fileUrl;
  }

  // --- Optional / normalized fields ----------------------------------------
  const receiverId = m.receiver == null ? null : extractId(m.receiver);

  // `fileMetadata`: default to "{}" when absent or explicitly nullish.
  const fileMetadataJson =
    m.fileMetadata == null ? "{}" : stringifyOrDefault(m.fileMetadata);

  // `replyTo`: stringify when present, otherwise null.
  const replyToJson =
    m.replyTo == null ? null : stringifyOrDefault(m.replyTo);

  // `status`: enum-validated; default to "sent" for server-confirmed payloads
  // that omit the field (the backend always includes it in practice, but we
  // do not reject based on its absence — it's not in the Req 1.3 required
  // set).
  /** @type {LocalMessage["status"]} */
  let status = "sent";
  if (
    m.status === "pending" ||
    m.status === "sent" ||
    m.status === "delivered" ||
    m.status === "read" ||
    m.status === "failed"
  ) {
    status = m.status;
  }

  /** @type {LocalMessage} */
  const row = {
    serverId,
    clientTempId: optString(m.clientTempId),
    senderId,
    receiverId,
    channelId: optString(m.channelId),
    messageType,
    content,
    fileUrl,
    fileName: optString(m.fileName),
    fileMetadataJson,
    replyToJson,
    status,
    deletedForEveryone: m.deletedForEveryone === true,
    deletedAt: optString(m.deletedAt),
    createdAt,
    updatedAt,
    syncState: "confirmed",
    queueSeq: null,
    localFilePath: null,
  };

  return ok(row);
}

// ---------------------------------------------------------------------------
// toWirePayload
// ---------------------------------------------------------------------------

/**
 * Inverse of `toLocalRow`: convert a server-confirmed `Local_Database` row
 * back into a server message payload shape suitable for round-tripping
 * through the backend or comparing against a fresh sync result.
 *
 * - Restores `sender` and `receiver` to the populated `{ _id }` subdoc form
 *   (the form most backend responses return).
 * - Parses `fileMetadataJson` and `replyToJson` back into structured values.
 * - Omits local-only fields (`id`, `conversationId`, `conversationType`,
 *   `syncState`, `queueSeq`, `localFilePath`, `deletedForMe`).
 * - Returns a typed error result (without throwing) if any required field on
 *   the local row is missing — this is defensive: well-formed rows produced
 *   by `toLocalRow` always satisfy these checks.
 *
 * @param {unknown} row
 * @returns {Result<ServerMessage, WireFormatError>}
 */
export function toWirePayload(row) {
  if (!isPlainObject(row)) return missing("_id");

  const serverId = optString(row.serverId);
  if (serverId === null) return missing("_id");

  const senderId = optString(row.senderId);
  if (senderId === null) return missing("sender");

  const messageType = row.messageType;
  if (
    messageType !== "text" &&
    messageType !== "file" &&
    messageType !== "call"
  ) {
    return missing("messageType");
  }

  const createdAt = optString(row.createdAt);
  if (createdAt === null) return missing("createdAt");

  const updatedAt = optString(row.updatedAt);
  if (updatedAt === null) return missing("updatedAt");

  if (messageType === "text" && typeof row.content !== "string") {
    return missing("content");
  }
  if (messageType === "file") {
    if (typeof row.fileUrl !== "string" || row.fileUrl.length === 0) {
      return missing("fileUrl");
    }
  }

  const receiverId = optString(row.receiverId);

  const fileMetadata = parseOrFallback(
    typeof row.fileMetadataJson === "string" ? row.fileMetadataJson : "{}",
    {}
  );

  const replyTo =
    typeof row.replyToJson === "string" && row.replyToJson.length > 0
      ? parseOrFallback(row.replyToJson, null)
      : null;

  /** @type {ServerMessage} */
  const payload = {
    _id: serverId,
    sender: { _id: senderId },
    receiver: receiverId === null ? null : { _id: receiverId },
    messageType,
    content: typeof row.content === "string" ? row.content : null,
    fileUrl: typeof row.fileUrl === "string" ? row.fileUrl : null,
    fileName: typeof row.fileName === "string" ? row.fileName : null,
    fileMetadata: /** @type {Record<string, unknown>} */ (
      isPlainObject(fileMetadata) ? fileMetadata : {}
    ),
    replyTo: isPlainObject(replyTo) ? /** @type {object} */ (replyTo) : null,
    status:
      row.status === "pending" ||
      row.status === "sent" ||
      row.status === "delivered" ||
      row.status === "read" ||
      row.status === "failed"
        ? row.status
        : "sent",
    channelId: optString(row.channelId),
    deletedForEveryone: row.deletedForEveryone === true,
    deletedAt: optString(row.deletedAt),
    createdAt,
    updatedAt,
  };

  const clientTempId = optString(row.clientTempId);
  if (clientTempId !== null) payload.clientTempId = clientTempId;

  return ok(payload);
}
