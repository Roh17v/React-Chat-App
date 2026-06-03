/**
 * Diagnostics ring buffer for the offline layer.
 *
 * Implements §3.11 of the offline-support design and Requirements 14.1, 14.3,
 * and 14.4.
 *
 *   - Fixed-size circular buffer (default 200 entries).
 *   - `log({ category, code, durationMs?, outcome, meta? })` — synchronous, never
 *     blocks, never throws.
 *   - `snapshot()` returns the buffered events plus four projections pulled from
 *     injected getters (schemaVersion / localEncryption / mediaCacheSize /
 *     outboundQueueLength). Defaults to safe placeholders when no provider is
 *     wired up yet.
 *   - `toClipboardText()` produces TSV-ish lines suitable for support copy-paste,
 *     with message content, file bytes, and auth tokens scrubbed (Req 14.4 /
 *     Property 22).
 *
 * Two entry points are exported: a process-wide singleton via `getDiagnostics()`
 * and a factory `createDiagnostics({ capacity })` for tests.
 *
 * @module offline/utils/Diagnostics
 */

const DEFAULT_CAPACITY = 200;

/**
 * Substrings that mark a meta key as secret-bearing. Matched case-insensitively
 * as a substring of the key name. Keys are dropped wholesale; values are never
 * inspected for secret content (callers are responsible for not passing
 * sensitive values under non-secret-looking keys).
 */
const SECRET_KEY_HINTS = [
  "token",
  "password",
  "passphrase",
  "auth",
  "secret",
  "content",
  "filebody",
  "filebytes",
  "bytes",
];

/**
 * Categories accepted on logged events. Exported for callers that want to keep
 * their `category` strings aligned with the design.
 */
export const DIAGNOSTIC_CATEGORIES = Object.freeze([
  "boot",
  "migration",
  "bootstrap",
  "incremental",
  "live",
  "outbound",
  "media",
  "encryption",
  "error",
]);

/**
 * Outcomes accepted on logged events.
 */
export const DIAGNOSTIC_OUTCOMES = Object.freeze(["ok", "warn", "error"]);

/**
 * @typedef {Object} DiagnosticsEvent
 * @property {string} ts ISO-8601 timestamp.
 * @property {string} category One of {@link DIAGNOSTIC_CATEGORIES}.
 * @property {string} code Stable diagnostic code (e.g. `SQLITE_OPEN_FAILED`).
 * @property {number} [durationMs] Optional duration in milliseconds.
 * @property {string} outcome One of {@link DIAGNOSTIC_OUTCOMES}.
 * @property {Object<string, string|number|boolean>} [meta] Sanitized metadata.
 */

/**
 * @typedef {Object} DiagnosticsSnapshot
 * @property {DiagnosticsEvent[]} events Up to `capacity` events, oldest first.
 * @property {number|null} schemaVersion
 * @property {"secure"|"none"|null} localEncryption
 * @property {number} mediaCacheSize Bytes.
 * @property {number} outboundQueueLength Rows.
 */

/**
 * @typedef {Object} SnapshotProviders
 * @property {() => number|null} [getSchemaVersion]
 * @property {() => "secure"|"none"|null} [getLocalEncryption]
 * @property {() => number} [getMediaCacheSize]
 * @property {() => number} [getOutboundQueueLength]
 */

/**
 * Detect binary-ish values (raw bytes) that must never be serialized into
 * diagnostics output. Uint8Array / ArrayBuffer / Node Buffer all qualify.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isBinaryLike(value) {
  if (value == null) return false;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return true;
  // Node Buffer (in tests) — Buffer extends Uint8Array, already covered above,
  // but keep the explicit check for older runtimes.
  if (typeof globalThis.Buffer !== "undefined" && globalThis.Buffer.isBuffer?.(value)) return true;
  return false;
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSecretKey(key) {
  const lower = String(key).toLowerCase();
  for (const hint of SECRET_KEY_HINTS) {
    if (lower.includes(hint)) return true;
  }
  return false;
}

/**
 * Recursively sanitize a meta value:
 *   - drops object keys that look secret-bearing,
 *   - replaces binary-like values with a `<bytes:N>` placeholder,
 *   - leaves primitives untouched.
 *
 * The result is always JSON-serializable.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitizeValue(value, depth = 0) {
  if (depth > 6) return "<truncated>";
  if (value == null) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (isBinaryLike(value)) {
    const len =
      typeof value.byteLength === "number"
        ? value.byteLength
        : typeof value.length === "number"
          ? value.length
          : 0;
    return `<bytes:${len}>`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }
  if (t === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  // functions, symbols, bigints — coerce to a safe string label.
  return `<${t}>`;
}

/**
 * Sanitize a top-level meta object. Returns `undefined` if there is no meta or
 * the result would be empty (keeps log lines tight).
 *
 * @param {unknown} meta
 * @returns {Record<string, unknown> | undefined}
 */
function sanitizeMeta(meta) {
  if (meta == null || typeof meta !== "object") return undefined;
  const sanitized = sanitizeValue(meta, 0);
  if (
    sanitized &&
    typeof sanitized === "object" &&
    !Array.isArray(sanitized) &&
    Object.keys(sanitized).length === 0
  ) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (sanitized);
}

/**
 * Build a TSV-friendly cell out of an arbitrary string, replacing tab and
 * newline characters with spaces so a single event always occupies a single
 * line in `toClipboardText()` output.
 *
 * @param {unknown} v
 * @returns {string}
 */
function tsvCell(v) {
  if (v == null) return "";
  return String(v).replace(/[\t\r\n]+/g, " ");
}

/**
 * @param {unknown} meta
 * @returns {string}
 */
function metaToJson(meta) {
  if (meta == null) return "";
  try {
    return JSON.stringify(meta);
  } catch {
    return "<unserializable>";
  }
}

/**
 * Create a fresh Diagnostics instance. Used by tests; production code should
 * use {@link getDiagnostics}.
 *
 * @param {{ capacity?: number, now?: () => number }} [opts]
 * @returns {{
 *   log: (event: { category: string, code: string, durationMs?: number, outcome: string, meta?: object }) => void,
 *   snapshot: () => DiagnosticsSnapshot,
 *   toClipboardText: () => string,
 *   setSnapshotProviders: (providers: SnapshotProviders) => void,
 *   clear: () => void,
 *   capacity: number,
 * }}
 */
export function createDiagnostics(opts = {}) {
  const capacity =
    Number.isInteger(opts.capacity) && opts.capacity > 0
      ? opts.capacity
      : DEFAULT_CAPACITY;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  /** @type {(DiagnosticsEvent | undefined)[]} */
  const buffer = new Array(capacity);
  // `head` is the index where the next event will be written.
  // `count` is the number of valid events currently stored (≤ capacity).
  let head = 0;
  let count = 0;
  // Last assigned timestamp in ms. Used to enforce monotonic non-decreasing
  // timestamps even if the wall clock jitters backwards.
  let lastTsMs = 0;

  /** @type {SnapshotProviders} */
  let providers = {};

  /**
   * Append a single event. Never throws; on bad input it best-effort coerces
   * fields rather than rejecting (diagnostics must not break callers).
   */
  function log(event) {
    try {
      const incoming = event && typeof event === "object" ? event : {};
      const tsMs = Math.max(now(), lastTsMs);
      lastTsMs = tsMs;

      const sanitizedMeta = sanitizeMeta(incoming.meta);

      /** @type {DiagnosticsEvent} */
      const entry = {
        ts: new Date(tsMs).toISOString(),
        category: typeof incoming.category === "string" ? incoming.category : "error",
        code: typeof incoming.code === "string" ? incoming.code : "UNKNOWN",
        outcome: typeof incoming.outcome === "string" ? incoming.outcome : "warn",
      };
      if (typeof incoming.durationMs === "number" && Number.isFinite(incoming.durationMs)) {
        entry.durationMs = incoming.durationMs;
      }
      if (sanitizedMeta !== undefined) {
        entry.meta = /** @type {Record<string, string|number|boolean>} */ (sanitizedMeta);
      }

      buffer[head] = entry;
      head = (head + 1) % capacity;
      if (count < capacity) count += 1;
    } catch {
      // Diagnostics must never throw to its caller. Swallow.
    }
  }

  /**
   * Return events in chronological (oldest-first) order. Snapshot is a copy;
   * callers cannot mutate the buffer through it.
   */
  function readEvents() {
    /** @type {DiagnosticsEvent[]} */
    const out = new Array(count);
    // Oldest event sits at `head - count` (mod capacity) when `count < capacity`,
    // and at `head` when the buffer has wrapped (count === capacity).
    const start = count < capacity ? (head - count + capacity) % capacity : head;
    for (let i = 0; i < count; i += 1) {
      const slot = (start + i) % capacity;
      out[i] = buffer[slot];
    }
    return out;
  }

  function snapshot() {
    const getSchemaVersion = providers.getSchemaVersion;
    const getLocalEncryption = providers.getLocalEncryption;
    const getMediaCacheSize = providers.getMediaCacheSize;
    const getOutboundQueueLength = providers.getOutboundQueueLength;

    return {
      events: readEvents(),
      schemaVersion: safeCallNullable(getSchemaVersion, null),
      localEncryption: safeCallNullable(getLocalEncryption, null),
      mediaCacheSize: safeCallNumber(getMediaCacheSize, 0),
      outboundQueueLength: safeCallNumber(getOutboundQueueLength, 0),
    };
  }

  function toClipboardText() {
    const snap = snapshot();
    const headerLines = [
      `schemaVersion\t${tsvCell(snap.schemaVersion)}`,
      `localEncryption\t${tsvCell(snap.localEncryption)}`,
      `mediaCacheSize\t${tsvCell(snap.mediaCacheSize)}`,
      `outboundQueueLength\t${tsvCell(snap.outboundQueueLength)}`,
      "ts\tcategory\tcode\toutcome\tdurationMs\tmeta",
    ];
    const eventLines = snap.events.map((e) =>
      [
        tsvCell(e.ts),
        tsvCell(e.category),
        tsvCell(e.code),
        tsvCell(e.outcome),
        tsvCell(e.durationMs ?? ""),
        tsvCell(metaToJson(e.meta)),
      ].join("\t"),
    );
    return [...headerLines, ...eventLines].join("\n");
  }

  function setSnapshotProviders(next) {
    providers = next && typeof next === "object" ? { ...next } : {};
  }

  function clear() {
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = undefined;
    head = 0;
    count = 0;
    lastTsMs = 0;
  }

  return {
    log,
    snapshot,
    toClipboardText,
    setSnapshotProviders,
    clear,
    capacity,
  };
}

/**
 * @template T
 * @param {(() => T) | undefined} fn
 * @param {T} fallback
 * @returns {T}
 */
function safeCallNullable(fn, fallback) {
  if (typeof fn !== "function") return fallback;
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * @param {(() => number) | undefined} fn
 * @param {number} fallback
 * @returns {number}
 */
function safeCallNumber(fn, fallback) {
  if (typeof fn !== "function") return fallback;
  try {
    const v = fn();
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** @type {ReturnType<typeof createDiagnostics> | null} */
let singleton = null;

/**
 * Process-wide singleton used by every offline-layer module. Tests should
 * prefer {@link createDiagnostics} so they get an isolated buffer.
 */
export function getDiagnostics() {
  if (singleton == null) {
    singleton = createDiagnostics();
  }
  return singleton;
}

/**
 * Reset the singleton. Exported for test setup; production code never calls
 * this.
 *
 * @internal
 */
export function __resetDiagnosticsSingletonForTests() {
  singleton = null;
}

// Export sanitizer helpers for the secret-exclusion property test (Property 22)
// and for any future callers that want to pre-scrub meta themselves. Not part
// of the public surface used by the rest of the offline module.
export const __internals = Object.freeze({
  sanitizeMeta,
  sanitizeValue,
  isSecretKey,
  isBinaryLike,
  SECRET_KEY_HINTS,
});
