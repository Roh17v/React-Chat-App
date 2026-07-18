// @ts-check
/**
 * Media_Cache for the offline store.
 *
 * Implements task 13.1 of the offline-support spec, covering Requirements
 * 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, and 10.5. Companion task
 * 13.2 (`downloadOnTap`) is also implemented here so the manual-download
 * surface lives next to the auto-download path.
 *
 * Design references:
 *   - §3.7 Media_Cache (on-disk layout, eviction algorithm, auto-download
 *     skip rule)
 *   - §Data Models / Schema v1 (the `media_cache` table — already created
 *     by migration 001)
 *   - §3.11 Diagnostics ring buffer (`category = "media"` codes)
 *
 * What this module owns:
 *
 *   1. Auto-download lifecycle on every incoming server `file` message.
 *      `onServerMessages([m, ...])` and `onLiveMessage(m)` are the entry
 *      points the SyncEngine / repository call after a committed write.
 *      The hook inserts/updates the `media_cache` row by `serverFileUrl`,
 *      decides between auto-download and "not_downloaded" based on
 *      `meta.media_auto_download_max_bytes`, and runs the download in the
 *      background (Req 8.1, 8.7).
 *
 *   2. Retry policy (Req 8.9). On HTTP / disk-write failure the download
 *      is retried up to 3 times with exponential backoff
 *      (`min(2_000 * 2^(n-1), 60_000)` ± 25% jitter). The final failure
 *      flips the row to `status = "download_failed"`.
 *
 *   3. Read API (Req 8.3 / Property 14). `getCachedMediaPath(url)` returns
 *      the local path iff the row is `downloaded` AND the file on disk is
 *      readable; on every successful read we bump `last_accessed_at`
 *      (Req 8.4). When the on-disk file has gone missing under our feet
 *      (user cleared cache / OS evicted) we flip the row to
 *      `download_failed` so the next tap re-downloads.
 *
 *   4. LRU eviction (Req 8.5 / 8.6 / Property 15). `evictIfOverBudget()`
 *      runs after every successful download, on a 5-minute timer, and on
 *      explicit caller request. Selects rows ordered by
 *      `(last_accessed_at ASC, downloaded_at ASC)` and deletes from the
 *      head until total bytes are at or below the budget. Rows touched
 *      within the last 5s are skipped to avoid evicting a file the UI is
 *      reading from at this very moment (§3.7 last paragraph).
 *
 *   5. Profile image re-download (Req 8.8). `onUserImageChanged({ userId,
 *      oldImage, newImage })` invalidates any cached entry for the old
 *      URL and queues a fresh download for the new URL.
 *
 *   6. `downloadOnTap(url)` (task 13.2 / Req 8.7). Force-downloads even
 *      when `byteSize > auto_download_max_bytes`. Re-uses the same
 *      retry/backoff pipeline as the auto path.
 *
 * Storage layout (Capacitor Filesystem `Directory.Data`):
 *
 *     /files/media/cache/<sha256(serverFileUrl)>.<ext>
 *     /files/media/profile/<sha256(serverFileUrl)>.<ext>
 *
 * The repository wipes the `files/media` tree wholesale on logout
 * (Req 1.6 / Req 10.5), so every cached file lives inside the app-private
 * sandbox.
 *
 * Dependency injection: every platform-specific module (`@capacitor/filesystem`,
 * `axios`, `crypto.subtle`) is supplied via {@link createMediaCache}. Tests
 * inject in-memory shims; production wires the real plugins via
 * {@link getMediaCache}.
 *
 * @module offline/services/MediaCache
 */

import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import axios from "axios";

import { getDiagnostics } from "../utils/Diagnostics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cache subtree under `Directory.Data`. Mirrors §3.7. Production code
 * always passes `directory: Directory.Data` along with one of these path
 * prefixes when calling `Filesystem.*`.
 */
export const MEDIA_DIRECTORY = Directory.Data;

/** Path prefix for chat file cache entries. */
export const MEDIA_CACHE_PATH = "files/media/cache";

/** Path prefix for cached profile images. */
export const MEDIA_PROFILE_PATH = "files/media/profile";

/**
 * Max retry count for a single URL (Req 8.9). The first try is attempt 1;
 * `MAX_DOWNLOAD_ATTEMPTS = 3` therefore allows up to 2 retries before the
 * row flips to `download_failed`. The constant matches the spec wording
 * verbatim ("up to 3 times").
 */
export const MAX_DOWNLOAD_ATTEMPTS = 3;

/** Backoff base (ms). Mirrors the OutboundQueue schedule (§3.4). */
export const BACKOFF_BASE_MS = 2_000;
/** Backoff cap (ms). */
export const BACKOFF_CAP_MS = 60_000;
/** ±25% uniform jitter applied on top of the exponential schedule. */
export const BACKOFF_JITTER_FRACTION = 0.25;

/**
 * Eviction cooldown window — rows touched within this many ms are skipped
 * during eviction so we do not yank a file the UI is currently reading.
 * §3.7 specifies 5s.
 */
export const EVICTION_COOLDOWN_MS = 5_000;

/** Default eviction-timer cadence (5 minutes per §3.7). */
export const DEFAULT_EVICTION_INTERVAL_MS = 5 * 60 * 1_000;

/** Default per-user storage budget (1 GiB per Req 8.5). Only used if
 *  `meta.media_budget_bytes` is unreadable. */
export const DEFAULT_MEDIA_BUDGET_BYTES = 1_073_741_824;

/** Default per-message auto-download cap (25 MiB per Req 8.7 default). */
export const DEFAULT_MEDIA_AUTO_DOWNLOAD_MAX_BYTES = 26_214_400;

// ---------------------------------------------------------------------------
// Types (JSDoc only — the project does not ship TypeScript)
// ---------------------------------------------------------------------------

/**
 * Subset of the SQLite driver surface this module relies on. Both the
 * production driver and the test driver already satisfy it.
 *
 * @typedef {Object} MediaCacheDriver
 * @property {(sql: string, values?: unknown[]) => Promise<{ changes: number, lastId?: number }>} run
 * @property {<T = unknown>(sql: string, values?: unknown[]) => Promise<T[]>} query
 * @property {<T>(work: (tx: MediaCacheDriver) => Promise<T>) => Promise<T>} withTransaction
 */

/**
 * Subset of the repository surface MediaCache consumes. We only need a
 * driver handle — every read/write goes directly through SQL so the cache
 * stays decoupled from the repository's per-conversation mutex.
 *
 * @typedef {Object} MediaCacheRepository
 * @property {() => MediaCacheDriver} getDriver
 * @property {() => boolean} [isReady]
 */

/**
 * Capacitor-shaped Filesystem surface. `@capacitor/filesystem` already
 * exposes these methods; tests inject an in-memory shim that records the
 * calls.
 *
 * @typedef {Object} MediaCacheFilesystem
 * @property {(opts: { path: string, data: string, directory?: string, recursive?: boolean }) => Promise<unknown>} writeFile
 * @property {(opts: { path: string, directory?: string }) => Promise<{ data: string | Blob | ArrayBuffer }>} readFile
 * @property {(opts: { path: string, directory?: string }) => Promise<unknown>} deleteFile
 * @property {(opts: { path: string, directory?: string }) => Promise<{ size?: number, type?: string }>} stat
 * @property {(opts: { path: string, directory?: string, recursive?: boolean }) => Promise<unknown>} [mkdir]
 */

/**
 * Subset of axios used for the download call.
 *
 * @typedef {Object} MediaCacheHttp
 * @property {(url: string, opts?: { responseType?: string, timeout?: number, headers?: Record<string, string>, signal?: AbortSignal }) => Promise<{ data: ArrayBuffer | Uint8Array, headers?: Record<string, string> }>} get
 */

/**
 * @typedef {(input: string) => Promise<string>} MediaCacheHasher
 *   SHA-256 hex hasher. Defaults to a `crypto.subtle` based implementation.
 *   Tests inject a deterministic stub.
 */

/**
 * @typedef {Object} CreateMediaCacheOptions
 * @property {MediaCacheRepository} repository Required.
 * @property {MediaCacheFilesystem} [filesystem]
 *   Defaults to the Capacitor `Filesystem` plugin on native platforms, and
 *   to a no-op stub elsewhere.
 * @property {MediaCacheHttp} [http]
 *   Defaults to the bare `axios` import. Tests inject a stub.
 * @property {MediaCacheHasher} [hash]
 *   Defaults to a `crypto.subtle.digest("SHA-256", …)` implementation.
 *   Tests inject `async (s) => s` so on-disk paths are deterministic.
 * @property {{ log: (e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void }} [diagnostics]
 *   Defaults to {@link getDiagnostics}.
 * @property {() => boolean} [isNativePlatform]
 *   Defaults to `Capacitor.isNativePlatform()`. Used to gate on-disk writes
 *   in the no-op fallback.
 * @property {() => number} [now]
 * @property {() => number} [random]
 *   Override `Math.random()` for deterministic backoff jitter in tests.
 * @property {(fn: () => void, ms: number) => unknown} [setTimeoutFn]
 * @property {(fn: () => void, ms: number) => unknown} [setIntervalFn]
 * @property {(handle: unknown) => void} [clearIntervalFn]
 * @property {number} [evictionIntervalMs]
 * @property {number} [cooldownMs]
 *   Eviction skip window. Defaults to {@link EVICTION_COOLDOWN_MS}.
 * @property {number} [maxAttempts]
 *   Defaults to {@link MAX_DOWNLOAD_ATTEMPTS}.
 * @property {number} [autoDownloadMaxBytes]
 *   Override the value read from `meta.media_auto_download_max_bytes`.
 *   When omitted MediaCache reads the meta row lazily.
 * @property {number} [budgetBytes]
 *   Override the value read from `meta.media_budget_bytes`.
 */

/**
 * @typedef {Object} MediaCache
 * @property {() => void} start
 *   Spin up the eviction timer. Idempotent.
 * @property {() => void} stop
 *   Tear down the eviction timer. Safe to call multiple times.
 * @property {(messages: unknown[]) => Promise<void>} onServerMessages
 *   Hook invoked by SyncEngine after `applyServerMessages` commits. Walks
 *   every `messageType === "file"` payload and queues an auto-download
 *   when applicable.
 * @property {(message: unknown) => Promise<void>} onLiveMessage
 *   Same as above for a single live event.
 * @property {(args: { userId?: string, oldImage?: string | null, newImage?: string | null }) => Promise<void>} onUserImageChanged
 *   Invalidate the cached profile image and queue a fresh download
 *   (Req 8.8).
 * @property {(serverFileUrl: string) => Promise<string | null>} getCachedMediaPath
 *   Read API used by the UI. Performs the §3.7 readability check and
 *   bumps `last_accessed_at`.
 * @property {() => Promise<{ evicted: number, bytesFreed: number }>} evictIfOverBudget
 *   Forced eviction pass. Returns the number of rows / bytes removed.
 * @property {(serverFileUrl: string, opts?: { mimeType?: string | null, byteSize?: number }) => Promise<{ ok: true, localFilePath: string } | { ok: false, reason: string }>} downloadOnTap
 *   Manual download. Bypasses the auto-download size gate (Req 8.7) but
 *   reuses the retry/backoff pipeline.
 * @property {() => Promise<number>} getTotalCachedBytes
 *   Diagnostics helper used by `Diagnostics.snapshot().mediaCacheSize`.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort SHA-256 hex hasher built on the Web Crypto API. Production
 * runtimes (Capacitor on Android, modern browsers, Node 18+) all expose
 * `crypto.subtle` — when it is missing we fall back to a stable djb2-ish
 * hash so tests on stripped-down runtimes still produce deterministic
 * filenames. The fallback is NOT cryptographic; for production it never
 * activates.
 *
 * @param {string} input
 * @returns {Promise<string>}
 */
async function defaultHash(input) {
  /** @type {{ subtle?: SubtleCrypto } | undefined} */
  const c =
    typeof globalThis !== "undefined"
      ? /** @type {any} */ (globalThis).crypto
      : undefined;
  if (c?.subtle?.digest) {
    const bytes = new TextEncoder().encode(String(input));
    const digest = await c.subtle.digest("SHA-256", bytes);
    return arrayBufferToHex(digest);
  }
  // Last-resort non-crypto fallback. Stable across runs for the same input.
  let h = BigInt(5381);
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << BigInt(5)) + h + BigInt(s.charCodeAt(i))) & BigInt("0xffffffffffffffff");
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
function arrayBufferToHex(buf) {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Convert an `ArrayBuffer` / `Uint8Array` to a base64 string. Capacitor's
 * `Filesystem.writeFile` accepts base64 when `data` is a string, which is
 * the only mode supported on every platform.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Browser path: btoa over latin-1 string. We chunk the conversion so
  // a 25 MiB file does not blow up the JS stack via apply(...spread).
  if (typeof btoa === "function") {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < view.length; i += CHUNK) {
      const slice = view.subarray(i, i + CHUNK);
      binary += String.fromCharCode.apply(null, /** @type {number[]} */ (Array.from(slice)));
    }
    return btoa(binary);
  }
  // Node test path: use Buffer.
  if (typeof globalThis !== "undefined" && /** @type {any} */ (globalThis).Buffer) {
    return /** @type {any} */ (globalThis).Buffer.from(view).toString("base64");
  }
  // Should never happen in practice; return empty string so downstream
  // writeFile fails fast with a descriptive error.
  return "";
}

/**
 * Best-effort filename extension extractor. Reads the trailing segment of
 * the URL pathname; falls back to `.bin` when the URL has no extension.
 *
 * @param {string} url
 * @returns {string}  Extension WITH a leading dot (e.g. `.jpg`).
 */
function extractExtension(url) {
  if (typeof url !== "string" || url.length === 0) return ".bin";
  // Strip query string / fragment, then take the last `/` segment.
  const cleaned = url.split("?")[0].split("#")[0];
  const lastSlash = cleaned.lastIndexOf("/");
  const tail = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  const dot = tail.lastIndexOf(".");
  if (dot < 0) return ".bin";
  const ext = tail.slice(dot).toLowerCase();
  // Sanity guard: extensions longer than 8 chars (excluding the dot) are
  // almost certainly garbage / not a real file extension.
  if (ext.length > 9) return ".bin";
  // Strip out characters that would be illegal in an Android filename.
  return ext.replace(/[^a-z0-9.]/gi, "");
}

/**
 * Extract the `byteSize` hint from a server message's `fileMetadata`.
 * Multiple shapes are tolerated because the field name has not been
 * standardized across backend producers; we look at the most common
 * spellings.
 *
 * @param {unknown} fileMetadata
 * @returns {number | null}
 */
function extractByteSize(fileMetadata) {
  if (fileMetadata == null || typeof fileMetadata !== "object") return null;
  const meta = /** @type {Record<string, unknown>} */ (fileMetadata);
  const candidates = ["byteSize", "size", "fileSize", "bytes", "contentLength"];
  for (const key of candidates) {
    const v = meta[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      return Math.floor(v);
    }
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

/**
 * Extract the `mimeType` hint from a server message's `fileMetadata`.
 *
 * @param {unknown} fileMetadata
 * @returns {string | null}
 */
function extractMimeType(fileMetadata) {
  if (fileMetadata == null || typeof fileMetadata !== "object") return null;
  const meta = /** @type {Record<string, unknown>} */ (fileMetadata);
  for (const key of ["mimeType", "mime_type", "mime", "contentType", "content_type"]) {
    const v = meta[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Coerce a SQLite integer column (which may come back as number, string,
 * or BigInt depending on driver) into a plain JS number.
 *
 * @param {unknown} value
 * @returns {number}
 */
function toIntegerOrZero(value) {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err.slice(0, 200);
  if (err instanceof Error) {
    return (err.message || err.name || "error").slice(0, 200);
  }
  try {
    return String(err).slice(0, 200);
  } catch {
    return "unprintable";
  }
}

/**
 * No-op Filesystem fallback used when the Capacitor plugin is unavailable
 * (web build, jsdom tests, Node CI without an injected stub).
 */
const NOOP_FILESYSTEM = Object.freeze({
  /** @returns {Promise<void>} */
  writeFile: async () => {
    throw new Error("filesystem unavailable");
  },
  /** @returns {Promise<{ data: string }>} */
  readFile: async () => {
    throw new Error("filesystem unavailable");
  },
  /** @returns {Promise<void>} */
  deleteFile: async () => undefined,
  /** @returns {Promise<{ size: number }>} */
  stat: async () => {
    throw new Error("filesystem unavailable");
  },
  /** @returns {Promise<void>} */
  mkdir: async () => undefined,
});

/**
 * Default axios-shaped HTTP client. Wraps the bare `axios` import so the
 * factory can swap a stub in tests without monkey-patching the module.
 *
 * @type {MediaCacheHttp}
 */
const DEFAULT_HTTP = {
  get: (url, opts) =>
    /** @type {any} */ (axios).get(url, opts).then((/** @type {any} */ r) => ({
      data: r.data,
      headers: r.headers,
    })),
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh MediaCache instance. Tests should construct their own via
 * this factory; production code should prefer {@link getMediaCache}.
 *
 * @param {CreateMediaCacheOptions} options
 * @returns {MediaCache}
 */
export function createMediaCache(options) {
  if (options == null || options.repository == null) {
    throw new Error("createMediaCache: repository is required");
  }
  const repository = options.repository;
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const isNativePlatform =
    typeof options.isNativePlatform === "function"
      ? options.isNativePlatform
      : () => Capacitor.isNativePlatform();
  const filesystem =
    options.filesystem != null
      ? options.filesystem
      : isNativePlatform()
        ? /** @type {MediaCacheFilesystem} */ (/** @type {unknown} */ (Filesystem))
        : NOOP_FILESYSTEM;
  const http = options.http != null ? options.http : DEFAULT_HTTP;
  const hash = typeof options.hash === "function" ? options.hash : defaultHash;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random =
    typeof options.random === "function" ? options.random : () => Math.random();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : setTimeout;
  const setIntervalFn =
    typeof options.setIntervalFn === "function" ? options.setIntervalFn : setInterval;
  const clearIntervalFn =
    typeof options.clearIntervalFn === "function"
      ? options.clearIntervalFn
      : clearInterval;
  const evictionIntervalMs =
    typeof options.evictionIntervalMs === "number" && options.evictionIntervalMs > 0
      ? options.evictionIntervalMs
      : DEFAULT_EVICTION_INTERVAL_MS;
  const cooldownMs =
    typeof options.cooldownMs === "number" && options.cooldownMs >= 0
      ? options.cooldownMs
      : EVICTION_COOLDOWN_MS;
  const maxAttempts =
    typeof options.maxAttempts === "number" && options.maxAttempts > 0
      ? Math.floor(options.maxAttempts)
      : MAX_DOWNLOAD_ATTEMPTS;
  const overrideAutoMax =
    typeof options.autoDownloadMaxBytes === "number" &&
    options.autoDownloadMaxBytes >= 0
      ? Math.floor(options.autoDownloadMaxBytes)
      : null;
  const overrideBudget =
    typeof options.budgetBytes === "number" && options.budgetBytes >= 0
      ? Math.floor(options.budgetBytes)
      : null;

  // ----- Mutable state ----------------------------------------------------

  /** @type {unknown} */
  let evictionTimer = null;
  let started = false;

  /**
   * In-flight download deferreds keyed by serverFileUrl. Used so a second
   * `processFileMessage(url)` call before the first finishes does not
   * spawn a duplicate fetch — both callers await the same promise.
   *
   * @type {Map<string, Promise<{ ok: boolean }>>}
   */
  const inFlight = new Map();

  // ----- DB helpers ------------------------------------------------------

  /**
   * @returns {MediaCacheDriver}
   */
  function driver() {
    /** @type {any} */
    const d = repository.getDriver();
    if (d == null) {
      throw new Error("MediaCache: repository.getDriver() returned null");
    }
    return /** @type {MediaCacheDriver} */ (d);
  }

  /**
   * Read the live `meta.media_auto_download_max_bytes` and
   * `meta.media_budget_bytes` values. Constructor overrides win over the
   * persisted values so tests can pin both.
   *
   * @returns {Promise<{ autoMax: number, budget: number }>}
   */
  async function readBudgetMeta() {
    if (overrideAutoMax != null && overrideBudget != null) {
      return { autoMax: overrideAutoMax, budget: overrideBudget };
    }
    /** @type {{ key?: unknown, value?: unknown }[]} */
    const rows = await driver().query(
      "SELECT key, value FROM meta WHERE key IN " +
        "('media_auto_download_max_bytes','media_budget_bytes')",
    );
    /** @type {Record<string, string>} */
    const map = {};
    for (const row of rows) {
      if (typeof row.key === "string" && row.value != null) {
        map[row.key] = String(row.value);
      }
    }
    const autoMax =
      overrideAutoMax != null
        ? overrideAutoMax
        : map.media_auto_download_max_bytes != null
          ? Math.max(0, parseInt(map.media_auto_download_max_bytes, 10) || 0)
          : DEFAULT_MEDIA_AUTO_DOWNLOAD_MAX_BYTES;
    const budget =
      overrideBudget != null
        ? overrideBudget
        : map.media_budget_bytes != null
          ? Math.max(0, parseInt(map.media_budget_bytes, 10) || 0)
          : DEFAULT_MEDIA_BUDGET_BYTES;
    return { autoMax, budget };
  }

  /**
   * @param {string} serverFileUrl
   * @returns {Promise<{
   *   server_file_url: string,
   *   local_file_path: string,
   *   mime_type: string | null,
   *   byte_size: number,
   *   status: string,
   *   attempts: number,
   *   downloaded_at: string | null,
   *   last_accessed_at: string | null,
   * } | null>}
   */
  async function getRow(serverFileUrl) {
    /** @type {Record<string, unknown>[]} */
    const rows = await driver().query(
      "SELECT server_file_url, local_file_path, mime_type, byte_size, status, " +
        "attempts, downloaded_at, last_accessed_at " +
        "FROM media_cache WHERE server_file_url = ? LIMIT 1",
      [serverFileUrl],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    return {
      server_file_url: String(row.server_file_url),
      local_file_path: String(row.local_file_path),
      mime_type:
        typeof row.mime_type === "string" && row.mime_type.length > 0
          ? row.mime_type
          : null,
      byte_size: toIntegerOrZero(row.byte_size),
      status: String(row.status),
      attempts: toIntegerOrZero(row.attempts),
      downloaded_at:
        typeof row.downloaded_at === "string" && row.downloaded_at.length > 0
          ? row.downloaded_at
          : null,
      last_accessed_at:
        typeof row.last_accessed_at === "string" && row.last_accessed_at.length > 0
          ? row.last_accessed_at
          : null,
    };
  }

  // ----- Path / hashing helpers -----------------------------------------

  /**
   * Compute the on-disk path (relative to {@link MEDIA_DIRECTORY}) for a
   * given server file URL. Caller picks the directory prefix
   * (`MEDIA_CACHE_PATH` for chat files, `MEDIA_PROFILE_PATH` for profile
   * images) so we do not conflate the two.
   *
   * @param {string} serverFileUrl
   * @param {string} prefix
   * @returns {Promise<string>}
   */
  async function buildLocalPath(serverFileUrl, prefix) {
    const digest = await hash(serverFileUrl);
    const ext = extractExtension(serverFileUrl);
    return `${prefix}/${digest}${ext}`;
  }

  // ----- Backoff helper --------------------------------------------------

  /**
   * Compute the backoff delay for `attempts` (1-indexed). Mirrors the
   * OutboundQueue schedule (§3.4 / Req 6.10) so the user-visible retry
   * cadence is consistent across the offline layer.
   *
   * @param {number} attempts
   * @returns {number}
   */
  function computeBackoffMs(attempts) {
    const exp = Math.max(1, attempts);
    const base =
      exp >= 30
        ? BACKOFF_CAP_MS
        : Math.min(BACKOFF_BASE_MS * Math.pow(2, exp - 1), BACKOFF_CAP_MS);
    const jitter = base * BACKOFF_JITTER_FRACTION * (random() * 2 - 1);
    return Math.max(0, Math.floor(base + jitter));
  }

  /**
   * Promise-shaped sleep used between download retries. Resolves after
   * `delayMs`. Built on the injected `setTimeoutFn` so tests can drive the
   * timing deterministically with `vi.useFakeTimers()` if desired.
   *
   * @param {number} delayMs
   * @returns {Promise<void>}
   */
  function sleep(delayMs) {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        setTimeoutFn(() => resolve(), delayMs);
      } catch {
        resolve();
      }
    });
  }

  // ----- Download core ---------------------------------------------------

  /**
   * Download `serverFileUrl` to `localFilePath` and update the
   * `media_cache` row to `status = "downloaded"` on success. Retries up
   * to `maxAttempts` times with exponential backoff (Req 8.9). On final
   * failure the row is marked `download_failed` (Req 8.9) and the partial
   * file (if any) is removed from disk.
   *
   * Concurrency: callers run through {@link processFileMessage} which
   * deduplicates by URL via the `inFlight` map, so this method assumes a
   * single writer per URL. No additional locking is needed.
   *
   * @param {string} serverFileUrl
   * @param {string} localFilePath
   * @param {string} directory     `Directory.Data` for production.
   * @returns {Promise<{ ok: true, byteSize: number, mimeType: string | null } | { ok: false, reason: string }>}
   */
  async function performDownload(serverFileUrl, localFilePath, directory) {
    let lastError = "unknown";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = now();
      try {
        const response = await http.get(serverFileUrl, {
          responseType: "arraybuffer",
          // Capacitor on slow networks: 30s is generous but still
          // bounded so a hung connection does not block the queue.
          timeout: 30_000,
        });
        const data = response?.data;
        if (data == null) {
          throw new Error("EMPTY_RESPONSE_BODY");
        }
        const view =
          data instanceof Uint8Array
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null;
        if (view == null) {
          throw new Error("UNEXPECTED_RESPONSE_BODY_TYPE");
        }
        const base64 = bytesToBase64(view);
        await filesystem.writeFile({
          path: localFilePath,
          data: base64,
          directory,
          recursive: true,
        });
        const mimeType =
          response?.headers && typeof response.headers === "object"
            ? typeof /** @type {any} */ (response.headers)["content-type"] === "string"
              ? /** @type {any} */ (response.headers)["content-type"]
              : null
            : null;
        diagnostics.log({
          category: "media",
          code: "MEDIA_DOWNLOAD_OK",
          outcome: "ok",
          durationMs: now() - startedAt,
          meta: { byteSize: view.byteLength, attempt },
        });
        return { ok: true, byteSize: view.byteLength, mimeType };
      } catch (err) {
        lastError = describeError(err);
        diagnostics.log({
          category: "media",
          code: "MEDIA_DOWNLOAD_RETRY",
          outcome: "warn",
          durationMs: now() - startedAt,
          meta: { attempt, maxAttempts, error: lastError },
        });
        if (attempt < maxAttempts) {
          await sleep(computeBackoffMs(attempt));
        }
      }
    }
    // Final failure — make sure no partial file lingers (best-effort).
    try {
      await filesystem.deleteFile({ path: localFilePath, directory });
    } catch {
      // Swallow — the file may not exist; not actionable.
    }
    return { ok: false, reason: lastError };
  }

  /**
   * Update the `media_cache` row with the final outcome of a download.
   *
   * @param {{
   *   serverFileUrl: string,
   *   localFilePath: string,
   *   status: "downloaded" | "download_failed" | "not_downloaded",
   *   byteSize?: number,
   *   mimeType?: string | null,
   *   attempts?: number,
   * }} args
   */
  async function persistOutcome(args) {
    const isoNow = new Date(now()).toISOString();
    const downloadedAt = args.status === "downloaded" ? isoNow : null;
    const lastAccessedAt = args.status === "downloaded" ? isoNow : null;
    const byteSize =
      typeof args.byteSize === "number" && Number.isFinite(args.byteSize) && args.byteSize >= 0
        ? Math.floor(args.byteSize)
        : 0;
    await driver().run(
      `INSERT INTO media_cache (
         server_file_url, local_file_path, mime_type, byte_size,
         status, attempts, downloaded_at, last_accessed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_file_url) DO UPDATE SET
         local_file_path  = excluded.local_file_path,
         mime_type        = COALESCE(excluded.mime_type, media_cache.mime_type),
         byte_size        = CASE WHEN excluded.byte_size > 0
                                  THEN excluded.byte_size
                                  ELSE media_cache.byte_size END,
         status           = excluded.status,
         attempts         = CASE WHEN excluded.attempts >= 0
                                  THEN excluded.attempts
                                  ELSE media_cache.attempts END,
         downloaded_at    = COALESCE(excluded.downloaded_at, media_cache.downloaded_at),
         last_accessed_at = COALESCE(excluded.last_accessed_at, media_cache.last_accessed_at)`,
      [
        args.serverFileUrl,
        args.localFilePath,
        args.mimeType ?? null,
        byteSize,
        args.status,
        typeof args.attempts === "number" ? Math.max(0, Math.floor(args.attempts)) : 0,
        downloadedAt,
        lastAccessedAt,
      ],
    );
  }

  /**
   * Insert/update the row in `status = "downloading"`. Returns the
   * resolved local path so the caller can pass it to
   * {@link performDownload}. Splitting the upsert from the download lets
   * the row reflect "we are working on this" while the network I/O is in
   * flight, which prevents duplicate downloads from concurrent live +
   * incremental events for the same URL (Req 8.1).
   *
   * @param {{ serverFileUrl: string, localFilePath: string, mimeType: string | null, byteSize: number }} args
   */
  async function markDownloading(args) {
    await driver().run(
      `INSERT INTO media_cache (
         server_file_url, local_file_path, mime_type, byte_size,
         status, attempts, downloaded_at, last_accessed_at
       ) VALUES (?, ?, ?, ?, 'downloading', 0, NULL, NULL)
       ON CONFLICT(server_file_url) DO UPDATE SET
         local_file_path = excluded.local_file_path,
         mime_type       = COALESCE(excluded.mime_type, media_cache.mime_type),
         byte_size       = CASE WHEN excluded.byte_size > 0
                                  THEN excluded.byte_size
                                  ELSE media_cache.byte_size END,
         status          = 'downloading'`,
      [
        args.serverFileUrl,
        args.localFilePath,
        args.mimeType,
        args.byteSize,
      ],
    );
  }

  // ----- Public: process a server file message --------------------------

  /**
   * Core decision tree for a single incoming `file` payload (called from
   * {@link onServerMessages} / {@link onLiveMessage}). Idempotent by URL
   * via the in-flight dedup map.
   *
   * @param {{ serverFileUrl: string, byteSize: number | null, mimeType: string | null, prefix?: string, force?: boolean }} args
   * @returns {Promise<{ ok: boolean }>}
   */
  async function processFileMessage(args) {
    const { serverFileUrl, byteSize, mimeType, force } = args;
    const prefix = args.prefix != null ? args.prefix : MEDIA_CACHE_PATH;

    if (typeof serverFileUrl !== "string" || serverFileUrl.length === 0) {
      return { ok: false };
    }

    // Dedup concurrent downloads for the same URL. `force=true` (e.g. an
    // explicit `downloadOnTap` after the auto path persisted
    // `not_downloaded`) deliberately bypasses the dedup so the user-tap
    // semantics are not coupled to whatever the background pass decided.
    if (!force) {
      const existing = inFlight.get(serverFileUrl);
      if (existing != null) return existing;
    }

    const work = (async () => {
      try {
        const row = await getRow(serverFileUrl);

        // Already downloaded — nothing to do (Req 8.1: cache once).
        if (row != null && row.status === "downloaded") {
          return { ok: true };
        }
        // Already downloading — let the in-flight promise win.
        if (row != null && row.status === "downloading" && !force) {
          // Defensive: stale `downloading` rows can appear after a crash.
          // Treat them as "we will pick up the download now".
        }

        const { autoMax } = await readBudgetMeta();
        const localFilePath = await buildLocalPath(serverFileUrl, prefix);

        // Auto-download skip rule (Req 8.7).
        if (!force && byteSize != null && byteSize > autoMax) {
          await persistOutcome({
            serverFileUrl,
            localFilePath,
            status: "not_downloaded",
            byteSize,
            mimeType,
            attempts: 0,
          });
          diagnostics.log({
            category: "media",
            code: "MEDIA_AUTO_DOWNLOAD_SKIPPED",
            outcome: "ok",
            meta: { byteSize, autoMax },
          });
          return { ok: true };
        }

        // Decided: download now.
        await markDownloading({
          serverFileUrl,
          localFilePath,
          mimeType,
          byteSize: byteSize != null ? byteSize : 0,
        });

        const result = await performDownload(
          serverFileUrl,
          localFilePath,
          MEDIA_DIRECTORY,
        );

        if (result.ok) {
          await persistOutcome({
            serverFileUrl,
            localFilePath,
            status: "downloaded",
            byteSize: result.byteSize,
            mimeType: mimeType ?? result.mimeType,
            attempts: 0,
          });
          // Eviction is a fast SQL pass; running it eagerly keeps the
          // budget tight without an extra timer wakeup (§3.7).
          try {
            await evictIfOverBudget();
          } catch (err) {
            diagnostics.log({
              category: "media",
              code: "MEDIA_EVICTION_FAILED",
              outcome: "warn",
              meta: { error: describeError(err) },
            });
          }
          return { ok: true };
        }

        await persistOutcome({
          serverFileUrl,
          localFilePath,
          status: "download_failed",
          byteSize: byteSize != null ? byteSize : 0,
          mimeType,
          attempts: maxAttempts,
        });
        diagnostics.log({
          category: "media",
          code: "MEDIA_DOWNLOAD_FAILED",
          outcome: "error",
          meta: {
            reason:
              /** @type {{ reason?: string }} */ (result).reason || "unknown",
            attempts: maxAttempts,
          },
        });
        return { ok: false };
      } catch (err) {
        diagnostics.log({
          category: "media",
          code: "MEDIA_PROCESS_FAILED",
          outcome: "error",
          meta: { error: describeError(err) },
        });
        return { ok: false };
      } finally {
        inFlight.delete(serverFileUrl);
      }
    })();

    inFlight.set(serverFileUrl, work);
    return work;
  }

  // ----- Public: hooks for the Sync_Engine ------------------------------

  /**
   * Walk a batch of server messages and queue an auto-download for every
   * `file` payload. Errors per message are isolated — a bad URL on
   * message N does not prevent message N+1 from being processed.
   *
   * Downloads kick off in parallel: each `onLiveMessage` call returns a
   * pending promise and we `Promise.all` them at the end so the caller
   * can synchronize on "every file in this batch has been processed". The
   * dedup map prevents duplicate downloads when the same URL appears
   * twice in a batch.
   *
   * @param {unknown[]} messages
   * @returns {Promise<void>}
   */
  async function onServerMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const work = [];
    for (const m of messages) {
      try {
        work.push(onLiveMessage(m));
      } catch (err) {
        diagnostics.log({
          category: "media",
          code: "MEDIA_ON_SERVER_MESSAGES_FAILED",
          outcome: "warn",
          meta: { error: describeError(err) },
        });
      }
    }
    await Promise.allSettled(work);
  }

  /**
   * Process a single live message. Awaits the per-URL download (or skip)
   * decision so tests and callers can synchronize on completion. Concurrent
   * `onLiveMessage` calls for different URLs run in parallel via the
   * dedup map; calls for the same URL share the same in-flight promise.
   *
   * @param {unknown} message
   * @returns {Promise<void>}
   */
  async function onLiveMessage(message) {
    if (message == null || typeof message !== "object") return;
    const m = /** @type {Record<string, unknown>} */ (message);
    if (m.messageType !== "file") return;
    if (typeof m.fileUrl !== "string" || m.fileUrl.length === 0) return;
    const fileMetadata = m.fileMetadata;
    const byteSize = extractByteSize(fileMetadata);
    const mimeType = extractMimeType(fileMetadata);
    await processFileMessage({
      serverFileUrl: m.fileUrl,
      byteSize,
      mimeType,
    });
  }

  /**
   * Profile image change hook (Req 8.8). The new URL is downloaded
   * eagerly (image previews are typically small) and the old URL's row,
   * if any, is evicted so the cache does not retain stale avatars.
   *
   * @param {{ userId?: string, oldImage?: string | null, newImage?: string | null }} args
   * @returns {Promise<void>}
   */
  async function onUserImageChanged(args) {
    if (args == null || typeof args !== "object") return;
    const oldImage =
      typeof args.oldImage === "string" && args.oldImage.length > 0
        ? args.oldImage
        : null;
    const newImage =
      typeof args.newImage === "string" && args.newImage.length > 0
        ? args.newImage
        : null;
    if (oldImage === newImage) return;

    if (oldImage != null) {
      try {
        const row = await getRow(oldImage);
        if (row != null) {
          // Best-effort delete on disk; the row is removed regardless.
          try {
            await filesystem.deleteFile({
              path: row.local_file_path,
              directory: MEDIA_DIRECTORY,
            });
          } catch {
            // Swallow — if the file is already missing the SQL delete is
            // still the right thing to do.
          }
          await driver().run(
            "DELETE FROM media_cache WHERE server_file_url = ?",
            [oldImage],
          );
        }
      } catch (err) {
        diagnostics.log({
          category: "media",
          code: "MEDIA_PROFILE_EVICT_FAILED",
          outcome: "warn",
          meta: { error: describeError(err) },
        });
      }
    }

    if (newImage != null) {
      await processFileMessage({
        serverFileUrl: newImage,
        byteSize: null, // unknown; profile pictures are small in practice
        mimeType: null,
        prefix: MEDIA_PROFILE_PATH,
      });
    }
  }

  // ----- Public: read API -----------------------------------------------

  /**
   * Look up the cached path for `serverFileUrl`. Returns `null` when:
   *   - the row does not exist,
   *   - the row's status is not `downloaded`,
   *   - the file at `local_file_path` is no longer readable.
   *
   * On a successful lookup we bump `last_accessed_at` to keep the row at
   * the tail of the LRU eviction order (Req 8.4 / Property 14).
   *
   * @param {string} serverFileUrl
   * @returns {Promise<string | null>}
   */
  async function getCachedMediaPath(serverFileUrl) {
    if (typeof serverFileUrl !== "string" || serverFileUrl.length === 0) {
      return null;
    }
    const row = await getRow(serverFileUrl);
    if (row == null) return null;
    if (row.status !== "downloaded") return null;

    // Disk readability check (Property 14).
    try {
      await filesystem.stat({
        path: row.local_file_path,
        directory: MEDIA_DIRECTORY,
      });
    } catch (err) {
      diagnostics.log({
        category: "media",
        code: "MEDIA_FILE_MISSING",
        outcome: "warn",
        meta: { error: describeError(err) },
      });
      // Flip the row so the next request triggers a fresh download
      // rather than thrashing on the disappearing file.
      try {
        await driver().run(
          "UPDATE media_cache SET status = 'download_failed' WHERE server_file_url = ?",
          [serverFileUrl],
        );
      } catch {
        // Swallow — a follow-up request will recover.
      }
      return null;
    }

    // Bump `last_accessed_at` (Req 8.4). Done outside any transaction
    // because failures here are non-fatal — the worst case is the row's
    // LRU position lags one tick behind reality.
    try {
      await driver().run(
        "UPDATE media_cache SET last_accessed_at = ? WHERE server_file_url = ?",
        [new Date(now()).toISOString(), serverFileUrl],
      );
    } catch {
      // Swallow.
    }

    return row.local_file_path;
  }

  // ----- Public: eviction -----------------------------------------------

  /**
   * Run the LRU eviction pass (Req 8.6 / Property 15). Skips rows whose
   * `last_accessed_at` is within {@link EVICTION_COOLDOWN_MS} of "now"
   * to avoid yanking a file the UI is reading. Rows in
   * `status != "downloaded"` are not counted toward the budget.
   *
   * @returns {Promise<{ evicted: number, bytesFreed: number }>}
   */
  async function evictIfOverBudget() {
    const { budget } = await readBudgetMeta();
    if (budget <= 0) return { evicted: 0, bytesFreed: 0 };

    /** @type {{ total?: unknown }[]} */
    const totalRows = await driver().query(
      "SELECT COALESCE(SUM(byte_size), 0) AS total FROM media_cache " +
        "WHERE status = 'downloaded'",
    );
    let total = toIntegerOrZero(totalRows[0]?.total);
    if (total <= budget) return { evicted: 0, bytesFreed: 0 };

    /** @type {{ server_file_url?: unknown, local_file_path?: unknown, byte_size?: unknown, last_accessed_at?: unknown }[]} */
    const candidates = await driver().query(
      "SELECT server_file_url, local_file_path, byte_size, last_accessed_at " +
        "FROM media_cache WHERE status = 'downloaded' " +
        // ASC means oldest first; tie-break by downloaded_at so two rows
        // never accessed end up consistently ordered.
        "ORDER BY last_accessed_at ASC, downloaded_at ASC",
    );

    const cutoff = now() - cooldownMs;
    let evicted = 0;
    let bytesFreed = 0;

    for (const candidate of candidates) {
      if (total <= budget) break;
      const url =
        typeof candidate.server_file_url === "string" ? candidate.server_file_url : null;
      const localPath =
        typeof candidate.local_file_path === "string" ? candidate.local_file_path : null;
      if (url == null || localPath == null) continue;

      // Skip if accessed within the cooldown window.
      const lastAccessedAt =
        typeof candidate.last_accessed_at === "string" ? candidate.last_accessed_at : null;
      if (lastAccessedAt != null) {
        const ts = Date.parse(lastAccessedAt);
        if (Number.isFinite(ts) && ts >= cutoff) continue;
      }

      const size = toIntegerOrZero(candidate.byte_size);

      try {
        await filesystem.deleteFile({
          path: localPath,
          directory: MEDIA_DIRECTORY,
        });
      } catch (err) {
        // The file may already be gone — keep going with the row delete
        // so we do not loop forever on the same victim.
        diagnostics.log({
          category: "media",
          code: "MEDIA_EVICT_FILE_DELETE_FAILED",
          outcome: "warn",
          meta: { error: describeError(err) },
        });
      }
      try {
        await driver().run(
          "DELETE FROM media_cache WHERE server_file_url = ?",
          [url],
        );
      } catch (err) {
        diagnostics.log({
          category: "media",
          code: "MEDIA_EVICT_ROW_DELETE_FAILED",
          outcome: "warn",
          meta: { error: describeError(err) },
        });
        // Stop the pass if the DB itself is misbehaving.
        break;
      }
      total -= size;
      bytesFreed += size;
      evicted += 1;
    }

    if (evicted > 0) {
      diagnostics.log({
        category: "media",
        code: "MEDIA_EVICTION_RAN",
        outcome: "ok",
        meta: { evicted, bytesFreed },
      });
    }
    return { evicted, bytesFreed };
  }

  // ----- Public: downloadOnTap (task 13.2) ------------------------------

  /**
   * Force-download a URL even if `byteSize > autoDownloadMaxBytes`. Used
   * by the UI when the user explicitly taps a not-yet-downloaded media
   * message (§3.7 last paragraph / Req 8.7).
   *
   * @param {string} serverFileUrl
   * @param {{ mimeType?: string | null, byteSize?: number }} [opts]
   * @returns {Promise<{ ok: true, localFilePath: string } | { ok: false, reason: string }>}
   */
  async function downloadOnTap(serverFileUrl, opts = {}) {
    if (typeof serverFileUrl !== "string" || serverFileUrl.length === 0) {
      return { ok: false, reason: "INVALID_URL" };
    }
    const result = await processFileMessage({
      serverFileUrl,
      byteSize:
        typeof opts.byteSize === "number" && Number.isFinite(opts.byteSize)
          ? Math.floor(opts.byteSize)
          : null,
      mimeType:
        typeof opts.mimeType === "string" && opts.mimeType.length > 0
          ? opts.mimeType
          : null,
      force: true,
    });
    if (!result.ok) {
      return { ok: false, reason: "DOWNLOAD_FAILED" };
    }
    const row = await getRow(serverFileUrl);
    if (row == null || row.status !== "downloaded") {
      return { ok: false, reason: "ROW_NOT_DOWNLOADED" };
    }
    return { ok: true, localFilePath: row.local_file_path };
  }

  // ----- Public: diagnostics --------------------------------------------

  /**
   * Sum of `byte_size` across every `downloaded` row. Wired into
   * {@link Diagnostics.snapshot} so support reports can show the actual
   * on-disk footprint.
   *
   * @returns {Promise<number>}
   */
  async function getTotalCachedBytes() {
    try {
      /** @type {{ total?: unknown }[]} */
      const rows = await driver().query(
        "SELECT COALESCE(SUM(byte_size), 0) AS total FROM media_cache " +
          "WHERE status = 'downloaded'",
      );
      return toIntegerOrZero(rows[0]?.total);
    } catch {
      return 0;
    }
  }

  // ----- Public: lifecycle ----------------------------------------------

  function start() {
    if (started) return;
    started = true;
    if (evictionIntervalMs > 0) {
      try {
        evictionTimer = setIntervalFn(() => {
          // Fire-and-forget; the function logs its own diagnostics.
          void evictIfOverBudget().catch(() => undefined);
        }, evictionIntervalMs);
      } catch (err) {
        diagnostics.log({
          category: "media",
          code: "MEDIA_TIMER_START_FAILED",
          outcome: "warn",
          meta: { error: describeError(err) },
        });
      }
    }
    diagnostics.log({
      category: "media",
      code: "MEDIA_CACHE_STARTED",
      outcome: "ok",
    });
  }

  function stop() {
    if (!started) return;
    started = false;
    if (evictionTimer != null) {
      try {
        clearIntervalFn(/** @type {any} */ (evictionTimer));
      } catch {
        // Swallow.
      }
      evictionTimer = null;
    }
    diagnostics.log({
      category: "media",
      code: "MEDIA_CACHE_STOPPED",
      outcome: "ok",
    });
  }

  return {
    start,
    stop,
    onServerMessages,
    onLiveMessage,
    onUserImageChanged,
    getCachedMediaPath,
    evictIfOverBudget,
    downloadOnTap,
    getTotalCachedBytes,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** @type {MediaCache | null} */
let singleton = null;

/**
 * Process-wide MediaCache used by the {@link OfflineProvider} and consumed
 * by the SyncEngine. Tests must use {@link createMediaCache} directly with
 * their own driver / filesystem / http stubs.
 *
 * The singleton is built lazily because it depends on the repository
 * singleton, which is itself built lazily by `getRepository()`.
 *
 * @param {{ repository?: MediaCacheRepository }} [opts]
 * @returns {MediaCache}
 */
export function getMediaCache(opts = {}) {
  if (singleton == null) {
    if (opts.repository == null) {
      throw new Error(
        "getMediaCache: repository is required on first call (pass it from OfflineProvider boot)",
      );
    }
    singleton = createMediaCache({ repository: opts.repository });
  }
  return singleton;
}

/**
 * Reset the singleton. Exported strictly for test setup; the production
 * boot path never calls this.
 *
 * @internal
 */
export function __resetMediaCacheSingletonForTests() {
  if (singleton != null) {
    try {
      singleton.stop();
    } catch {
      // Swallow.
    }
  }
  singleton = null;
}

// Internal helpers exposed for property tests (auto-download threshold,
// LRU eviction, cache lookup correctness — Properties 13 / 14 / 15) and
// for any caller that wants to construct deterministic on-disk paths.
export const __internals = Object.freeze({
  defaultHash,
  arrayBufferToHex,
  bytesToBase64,
  extractExtension,
  extractByteSize,
  extractMimeType,
  computeBackoffMsBaseline: (attempts, base, cap, jitterFraction, randomFn) => {
    const exp = Math.max(1, attempts);
    const b =
      exp >= 30 ? cap : Math.min(base * Math.pow(2, exp - 1), cap);
    const jitter = b * jitterFraction * (randomFn() * 2 - 1);
    return Math.max(0, Math.floor(b + jitter));
  },
});
