// @ts-check
/**
 * Outbound_Queue drain loop and retry orchestration.
 *
 * Implements task 10.1 of the offline-support design (§3.4) and validates
 * Requirements 6.1–6.10, 7.2, and 7.8.
 *
 * The repository owns the SQL-level write path
 * (`enqueueOutbound`, `markOutboundConfirmed`, `markOutboundFailed`). This
 * module owns the *runtime* aspects:
 *
 *   - {@link createOutboundQueue} returns a queue instance with the
 *     {@link OutboundQueue} surface (`start`, `stop`, `drain`,
 *     `triggerDrain`, `enqueue`).
 *   - `drain()` walks `outbound_queue` rows in `queue_seq ASC` order,
 *     marks them `in_flight`, performs the kind-specific I/O (socket
 *     emit, file upload + emit, axios PATCH), waits for confirmation via
 *     a `clientTempId` deferred (Req 6.4 / 6.5) or HTTP response, and
 *     finalizes the row through `markOutboundConfirmed` /
 *     `markOutboundFailed` / a backoff reschedule (Req 6.10).
 *   - Drain is triggered on: `start()` (when ready+online), every
 *     `enqueue` while online, connectivity transitions to `online`
 *     (Req 11.5), and a 60s timer.
 *   - Survives restart: on `start()` we roll any rows still marked
 *     `in_flight` back to `queued` so they replay on the next drain
 *     pass (Req 6.9). A 60s watcher keeps doing the same check while
 *     the app is running, in case a previous drain crashed mid-flight.
 *
 * The module is deliberately thin on dependencies: it talks to the
 * repository, the socket, the apiClient (axios-shaped), and a connectivity
 * provider. Wiring is the responsibility of {@link OfflineProvider}
 * (task 16.2) which has the live `socket` reference and the connectivity
 * service. Tests can construct an OutboundQueue directly with stubbed
 * dependencies.
 *
 * @module offline/sync/OutboundQueue
 */

import { getClientTempIdRegistry } from "./clientTempIdRegistry.js";
import { getDiagnostics } from "../utils/Diagnostics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum attempts before a queue item is moved to the `failed` terminal
 * state (Req 6.10). The 5-attempt cap is exact (the design spec calls for
 * "up to 5 attempts").
 */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff base in milliseconds. The schedule is `min(2_000 * 2^(n-1), 60_000)`
 * with ±25% jitter (Req 6.10 / §3.4). For `n = 1, 2, 3, 4` the cap-free
 * values are 2s, 4s, 8s, 16s; the cap is reached at `n ≥ 6`. The cap value
 * matches §3.4 verbatim.
 */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 60_000;
export const BACKOFF_JITTER_FRACTION = 0.25;

/**
 * Default drain timer interval (Req 6.10 / §3.4). The 60s timer covers two
 * cases at once: items whose `next_attempt_at` has elapsed since the last
 * drain, and stuck `in_flight` rows whose deferred has not resolved.
 */
export const DEFAULT_TIMER_INTERVAL_MS = 60_000;

/**
 * Max time a row may stay in `in_flight` before the watcher rolls it back
 * to `queued` (§3.4 "Item stuck `in_flight` for `> 60s` after the socket
 * disconnects" — generalized to any cause). The repository uses
 * `updated_at` as the in-flight timestamp.
 */
export const IN_FLIGHT_STUCK_MS = 60_000;

/**
 * Default per-emit confirmation timeout (Req 6.10 / §3.4).
 */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000;

/**
 * @typedef {"send_text"|"send_file"|"mark_read"|"delete_for_me"|"delete_for_everyone"} OutboundKind
 */

/**
 * @typedef {"queued"|"in_flight"|"succeeded"|"failed"} OutboundStatus
 */

/**
 * Subset of the repository surface this module relies on. Matches the public
 * surface of `frontend/src/offline/repositories/index.js`.
 *
 * @typedef {Object} OutboundRepository
 * @property {() => boolean} isReady
 * @property {(args: { kind: OutboundKind, conversationId: string, conversationType: "dm"|"channel", payload?: Record<string, unknown>, localFilePath?: string | null, clientTempId?: string }) => Promise<{ id: string, queueSeq: number, clientTempId: string | null, localMessage?: unknown }>} enqueueOutbound
 * @property {(args: { queueId: string, serverMessage?: unknown }) => Promise<void>} markOutboundConfirmed
 * @property {(args: { queueId: string, error?: unknown }) => Promise<void>} markOutboundFailed
 * @property {() => unknown} getDriver
 *   Returns the underlying SQLite driver. The OutboundQueue uses it
 *   directly for the in-flight rollback / drain-head SELECT / backoff
 *   reschedule writes — these are not user-visible state changes and
 *   don't belong on the repository's public read API.
 */

/**
 * Subset of `socket.io-client` Socket the queue relies on.
 *
 * @typedef {Object} OutboundSocket
 * @property {boolean} [connected]
 * @property {(event: string, payload: Record<string, unknown>) => void} emit
 */

/**
 * Subset of axios used for HTTP fallbacks.
 *
 * @typedef {Object} OutboundApiClient
 * @property {(url: string, formData: unknown, opts?: object) => Promise<{ data?: { fileUrl?: string } }>} post
 * @property {(url: string, body?: unknown, opts?: object) => Promise<unknown>} patch
 */

/**
 * Subset of the Connectivity service the queue subscribes to. Matches
 * `frontend/src/offline/services/Connectivity.js`.
 *
 * @typedef {Object} OutboundConnectivity
 * @property {() => "online"|"offline"|"reconnecting"} current
 * @property {(listener: (state: "online"|"offline"|"reconnecting") => void) => () => void} subscribe
 */

/**
 * Subset of {@link createClientTempIdRegistry}.
 *
 * @typedef {Object} OutboundTempIdRegistry
 * @property {(clientTempId: string, opts?: { timeoutMs?: number }) => Promise<unknown>} register
 * @property {(clientTempId: string, payload: unknown) => boolean} resolve
 * @property {(clientTempId: string, error: Error | string) => boolean} reject
 */

/**
 * @typedef {Object} OutboundQueueOptions
 * @property {OutboundRepository} repository
 * @property {OutboundSocket | null} [socket]
 *   Live socket. May be null at construction time and supplied later via
 *   {@link OutboundQueue.setSocket}. Until a socket is supplied, drain
 *   skips socket-bound kinds so they remain queued for a later attempt.
 * @property {OutboundApiClient} [apiClient]
 *   axios-shaped client. Required for `send_file` (upload) and the
 *   delete-for-me / delete-for-everyone PATCH paths. Tests inject a
 *   stub that records the calls.
 * @property {OutboundConnectivity | null} [connectivity]
 *   When supplied, the queue subscribes to it for `online` transitions.
 *   When omitted (e.g. tests without a live socket) the queue assumes
 *   online and relies on `triggerDrain()` calls.
 * @property {OutboundTempIdRegistry} [tempIdRegistry]
 *   Per-`clientTempId` deferred map. Defaults to {@link getClientTempIdRegistry}.
 * @property {{ log: (e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void }} [diagnostics]
 *   Defaults to {@link getDiagnostics}.
 * @property {string} [uploadFileRoute]
 *   Absolute URL for the upload-file POST. Defaults to the constants module
 *   value when wired through {@link OfflineProvider}.
 * @property {string} [messagesRoute]
 *   Path prefix for `delete-for-me` / `delete-for-everyone` PATCH calls.
 *   Defaults to `/api/messages`.
 * @property {number} [timerIntervalMs]
 * @property {number} [confirmationTimeoutMs]
 * @property {number} [maxAttempts]
 * @property {() => number} [now]
 *   Override `Date.now()` for deterministic tests.
 * @property {() => number} [random]
 *   Override `Math.random()` for deterministic backoff jitter in tests.
 * @property {(fn: () => void, ms: number) => unknown} [setTimeoutFn]
 * @property {(fn: () => void, ms: number) => unknown} [setIntervalFn]
 * @property {(handle: unknown) => void} [clearIntervalFn]
 * @property {(localFilePath: string) => Promise<unknown>} [readLocalFile]
 *   Async hook used to materialize a `FormData` body from a local path
 *   before the upload. Defaults to a no-op that throws — the
 *   OfflineProvider supplies a Capacitor `Filesystem.readFile` based
 *   implementation in production.
 */

/**
 * @typedef {Object} OutboundQueue
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {() => Promise<void>} drain
 * @property {() => void} triggerDrain
 * @property {(args: { kind: OutboundKind, conversationId: string, conversationType: "dm"|"channel", payload?: Record<string, unknown>, localFilePath?: string | null, clientTempId?: string }) => Promise<{ id: string, queueSeq: number, clientTempId: string | null, localMessage?: unknown }>} enqueue
 * @property {(socket: OutboundSocket | null) => void} setSocket
 * @property {() => boolean} isDraining
 */

/**
 * Build a fresh OutboundQueue instance.
 *
 * @param {OutboundQueueOptions} options
 * @returns {OutboundQueue}
 */
export function createOutboundQueue(options) {
  if (options == null || options.repository == null) {
    throw new Error("createOutboundQueue: repository is required");
  }
  const repository = options.repository;
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const tempIdRegistry =
    options.tempIdRegistry != null
      ? options.tempIdRegistry
      : getClientTempIdRegistry();
  const apiClient = options.apiClient != null ? options.apiClient : null;
  const messagesRoute =
    typeof options.messagesRoute === "string"
      ? options.messagesRoute
      : "/api/messages";
  const uploadFileRoute =
    typeof options.uploadFileRoute === "string"
      ? options.uploadFileRoute
      : `${messagesRoute}/upload-file`;
  const timerIntervalMs =
    typeof options.timerIntervalMs === "number" && options.timerIntervalMs > 0
      ? options.timerIntervalMs
      : DEFAULT_TIMER_INTERVAL_MS;
  const confirmationTimeoutMs =
    typeof options.confirmationTimeoutMs === "number" &&
    options.confirmationTimeoutMs > 0
      ? options.confirmationTimeoutMs
      : DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const maxAttempts =
    typeof options.maxAttempts === "number" && options.maxAttempts > 0
      ? options.maxAttempts
      : MAX_ATTEMPTS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random =
    typeof options.random === "function" ? options.random : () => Math.random();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : setTimeout;
  const setIntervalFn =
    typeof options.setIntervalFn === "function"
      ? options.setIntervalFn
      : setInterval;
  const clearIntervalFn =
    typeof options.clearIntervalFn === "function"
      ? options.clearIntervalFn
      : clearInterval;
  const readLocalFile =
    typeof options.readLocalFile === "function" ? options.readLocalFile : null;

  /** @type {OutboundSocket | null} */
  let socket = options.socket != null ? options.socket : null;
  /** @type {OutboundConnectivity | null} */
  const connectivity =
    options.connectivity != null ? options.connectivity : null;

  // ----- Mutable state ----------------------------------------------------

  let started = false;
  let drainInFlight = false;
  /** Pending re-drain request lodged while a drain is already running. */
  let drainPending = false;
  /** @type {unknown} */
  let timerHandle = null;
  /** @type {() => void} */
  let connectivityUnsub = () => {};

  /**
   * @returns {boolean}
   */
  function isOnline() {
    if (connectivity != null) {
      try {
        return connectivity.current() === "online";
      } catch {
        return false;
      }
    }
    // No connectivity provider — fall back to the socket's own state.
    return socket != null && socket.connected === true;
  }

  /**
   * @returns {ReturnType<OutboundRepository["getDriver"]>}
   */
  function driver() {
    return repository.getDriver();
  }

  // ----- Helpers ----------------------------------------------------------

  /**
   * @param {string} kind
   * @returns {boolean}
   */
  function kindRequiresSocket(kind) {
    return (
      kind === "send_text" || kind === "send_file" || kind === "mark_read"
    );
  }

  /**
   * Compute the backoff delay for `attempts` (1-indexed: the first retry is
   * `attempts = 1`). Returns the jittered value in milliseconds.
   *
   * Per §3.4 / Req 6.10:
   *   base = min(BACKOFF_BASE_MS * 2^(attempts - 1), BACKOFF_CAP_MS)
   *   jitter = base * 0.25 * (random() * 2 - 1)   ← uniform in ±25%
   *   delay = base + jitter
   *
   * The result is clamped to a non-negative integer so a particularly
   * small `random()` cannot produce a negative timer.
   *
   * @param {number} attempts
   * @returns {number}
   */
  function computeBackoffMs(attempts) {
    const exp = Math.max(1, attempts);
    // 2^(exp-1) * BASE — guard against `Infinity` for absurd `attempts`.
    let base;
    if (exp >= 30) {
      base = BACKOFF_CAP_MS;
    } else {
      base = Math.min(BACKOFF_BASE_MS * Math.pow(2, exp - 1), BACKOFF_CAP_MS);
    }
    const jitter = base * BACKOFF_JITTER_FRACTION * (random() * 2 - 1);
    const delay = base + jitter;
    return Math.max(0, Math.floor(delay));
  }

  /**
   * Roll any rows still marked `in_flight` back to `queued`. Called on
   * `start()` (Req 6.9) and from the 60s watcher for rows whose
   * `updated_at` is older than {@link IN_FLIGHT_STUCK_MS}.
   *
   * @param {{ stuckOnly?: boolean }} [opts]
   * @returns {Promise<{ rolled: number }>}
   */
  async function rollbackInFlight(opts = {}) {
    const d = /** @type {any} */ (driver());
    const nowIso = new Date(now()).toISOString();
    const cutoffIso = new Date(now() - IN_FLIGHT_STUCK_MS).toISOString();
    let result;
    if (opts.stuckOnly === true) {
      result = await d.run(
        "UPDATE outbound_queue SET status = 'queued', updated_at = ? " +
          "WHERE status = 'in_flight' AND updated_at <= ?",
        [nowIso, cutoffIso],
      );
    } else {
      result = await d.run(
        "UPDATE outbound_queue SET status = 'queued', updated_at = ? " +
          "WHERE status = 'in_flight'",
        [nowIso],
      );
    }
    const rolled =
      result != null && typeof result.changes === "number" ? result.changes : 0;
    if (rolled > 0) {
      diagnostics.log({
        category: "outbound",
        code: "OUTBOUND_INFLIGHT_ROLLED_BACK",
        outcome: "warn",
        meta: { rolled, stuckOnly: opts.stuckOnly === true },
      });
    }
    return { rolled };
  }

  /**
   * Read the next drain head: lowest `queue_seq` row in `queued` whose
   * `next_attempt_at` is null or due. Returns `null` when no candidate
   * is ready.
   *
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function readDrainHead() {
    const d = /** @type {any} */ (driver());
    const nowIso = new Date(now()).toISOString();
    const rows = /** @type {Record<string, unknown>[]} */ (
      await d.query(
        "SELECT * FROM outbound_queue " +
          "WHERE status = 'queued' " +
          "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) " +
          "ORDER BY queue_seq ASC LIMIT 1",
        [nowIso],
      )
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0];
  }

  /**
   * Atomically mark `id` as `in_flight`. Returns `true` when the update
   * landed (i.e. the row was still `queued`). The drain loop uses the
   * return value to detect concurrent winners — although we never have
   * two drain loops in flight (drainInFlight guard) the check costs us
   * nothing and protects against future multi-driver work.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function markInFlight(id) {
    const d = /** @type {any} */ (driver());
    const nowIso = new Date(now()).toISOString();
    const result = await d.run(
      "UPDATE outbound_queue SET status = 'in_flight', updated_at = ? " +
        "WHERE id = ? AND status = 'queued'",
      [nowIso, id],
    );
    return result != null && result.changes > 0;
  }

  /**
   * Apply a backoff reschedule: bump `attempts`, set `next_attempt_at`,
   * record the error, and revert the row to `queued`. Used after a
   * transient failure that has not yet exhausted `maxAttempts`.
   *
   * @param {string} id
   * @param {number} attempts
   * @param {string} errorMessage
   * @param {number} delayMs
   */
  async function rescheduleBackoff(id, attempts, errorMessage, delayMs) {
    const d = /** @type {any} */ (driver());
    const nowMs = now();
    const nextAttemptAtIso = new Date(nowMs + delayMs).toISOString();
    const updatedAtIso = new Date(nowMs).toISOString();
    await d.run(
      "UPDATE outbound_queue SET status = 'queued', attempts = ?, " +
        "next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      [attempts, nextAttemptAtIso, errorMessage, updatedAtIso, id],
    );
    diagnostics.log({
      category: "outbound",
      code: "OUTBOUND_BACKOFF",
      outcome: "warn",
      meta: { id, attempts, delayMs, reason: errorMessage },
    });
  }

  /**
   * Persist an updated `payload_json` for a queue row. Used by the
   * `send_file` flow to record the `fileUrl` returned by the upload so a
   * subsequent retry does not re-upload the same file.
   *
   * @param {string} id
   * @param {Record<string, unknown>} payload
   */
  async function patchPayload(id, payload) {
    const d = /** @type {any} */ (driver());
    const updatedAtIso = new Date(now()).toISOString();
    await d.run(
      "UPDATE outbound_queue SET payload_json = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(payload), updatedAtIso, id],
    );
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {{
   *   id: string,
   *   kind: OutboundKind,
   *   queueSeq: number,
   *   conversationId: string,
   *   conversationType: "dm"|"channel",
   *   payload: Record<string, unknown>,
   *   localFilePath: string | null,
   *   clientTempId: string | null,
   *   attempts: number,
   * }}
   */
  function decodeRow(row) {
    const id = String(row.id);
    /** @type {Record<string, unknown>} */
    let payload = {};
    if (typeof row.payload_json === "string" && row.payload_json.length > 0) {
      try {
        const parsed = JSON.parse(row.payload_json);
        if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = /** @type {Record<string, unknown>} */ (parsed);
        }
      } catch {
        payload = {};
      }
    }
    return {
      id,
      kind: /** @type {OutboundKind} */ (row.kind),
      queueSeq:
        typeof row.queue_seq === "number"
          ? row.queue_seq
          : parseInt(String(row.queue_seq), 10) || 0,
      conversationId: String(row.conversation_id),
      conversationType:
        row.conversation_type === "channel" ? "channel" : "dm",
      payload,
      localFilePath:
        typeof row.local_file_path === "string" && row.local_file_path.length > 0
          ? row.local_file_path
          : null,
      clientTempId:
        typeof row.client_temp_id === "string" && row.client_temp_id.length > 0
          ? row.client_temp_id
          : null,
      attempts:
        typeof row.attempts === "number"
          ? row.attempts
          : parseInt(String(row.attempts), 10) || 0,
    };
  }

  // ----- Kind-specific drivers -------------------------------------------

  /**
   * Build a serializable wire payload for `send_text` / `send_file`. The
   * receiver-vs-channel split mirrors the existing `MessageBar.jsx` emit.
   *
   * @param {ReturnType<typeof decodeRow>} item
   * @returns {Record<string, unknown>}
   */
  function buildSocketPayload(item) {
    const p = item.payload;
    /** @type {Record<string, unknown>} */
    const wire = {
      .../** @type {Record<string, unknown>} */ (p),
      clientTempId: item.clientTempId,
    };
    if (item.conversationType === "channel") {
      wire.channelId = item.conversationId;
    } else if (wire.receiver == null) {
      wire.receiver = item.conversationId;
    }
    return wire;
  }

  /**
   * Process `send_text` / `send_file` (after upload, if needed). Emits the
   * socket event and waits for the `clientTempId` deferred to settle.
   *
   * @param {ReturnType<typeof decodeRow>} item
   * @returns {Promise<unknown>} the server message payload on success
   */
  async function processMessageEmit(item) {
    if (socket == null || socket.connected === false) {
      throw Object.assign(new Error("SOCKET_NOT_CONNECTED"), {
        code: "SOCKET_NOT_CONNECTED",
      });
    }
    if (item.clientTempId == null) {
      throw Object.assign(new Error("CLIENT_TEMP_ID_MISSING"), {
        code: "CLIENT_TEMP_ID_MISSING",
      });
    }
    const event =
      item.conversationType === "channel"
        ? "send-channel-message"
        : "sendMessage";
    const wire = buildSocketPayload(item);
    // Register the deferred BEFORE emit so a synchronous backend ack
    // cannot race the registration. The repository's
    // `markOutboundConfirmed` resolves the deferred indirectly via the
    // SyncEngine when `receiveMessage` arrives.
    const waitPromise = tempIdRegistry.register(item.clientTempId, {
      timeoutMs: confirmationTimeoutMs,
    });
    socket.emit(event, wire);
    return waitPromise;
  }

  /**
   * Process `send_file` from a `queued` state. If the payload already
   * carries a `fileUrl` (a previous attempt uploaded but failed to emit),
   * skip the upload and reuse the existing URL — Req 6.8 says upload
   * before emit, but it does not say "upload again on every retry".
   *
   * @param {ReturnType<typeof decodeRow>} item
   * @returns {Promise<unknown>}
   */
  async function processSendFile(item) {
    let fileUrl =
      typeof item.payload.fileUrl === "string" && item.payload.fileUrl.length > 0
        ? item.payload.fileUrl
        : null;
    if (fileUrl == null) {
      if (apiClient == null) {
        throw Object.assign(new Error("API_CLIENT_MISSING"), {
          code: "API_CLIENT_MISSING",
        });
      }
      if (readLocalFile == null) {
        throw Object.assign(new Error("READ_LOCAL_FILE_MISSING"), {
          code: "READ_LOCAL_FILE_MISSING",
        });
      }
      if (item.localFilePath == null) {
        throw Object.assign(new Error("LOCAL_FILE_PATH_MISSING"), {
          code: "LOCAL_FILE_PATH_MISSING",
        });
      }
      const formData = await readLocalFile(item.localFilePath);
      const response = await apiClient.post(uploadFileRoute, formData, {
        withCredentials: true,
      });
      const uploadedUrl =
        response != null && response.data != null && typeof response.data.fileUrl === "string"
          ? response.data.fileUrl
          : null;
      if (uploadedUrl == null) {
        throw Object.assign(new Error("UPLOAD_NO_FILE_URL"), {
          code: "UPLOAD_NO_FILE_URL",
        });
      }
      fileUrl = uploadedUrl;
      // Persist the uploaded URL so a retry of the emit does not re-upload.
      const newPayload = { ...item.payload, fileUrl };
      await patchPayload(item.id, newPayload);
      item.payload = newPayload;
    }
    return processMessageEmit(item);
  }

  /**
   * Process `mark_read`. Fire-and-forget socket emit (Req 7.7 / 7.8): the
   * backend does not ack `confirm-read`, so we treat the emit itself as
   * success once the socket is connected.
   *
   * @param {ReturnType<typeof decodeRow>} item
   */
  async function processMarkRead(item) {
    if (socket == null || socket.connected === false) {
      throw Object.assign(new Error("SOCKET_NOT_CONNECTED"), {
        code: "SOCKET_NOT_CONNECTED",
      });
    }
    const senderId =
      typeof item.payload.senderId === "string"
        ? item.payload.senderId
        : null;
    const userIdFromPayload =
      typeof item.payload.userId === "string" ? item.payload.userId : null;
    if (senderId == null) {
      throw Object.assign(new Error("MARK_READ_INVALID"), {
        code: "MARK_READ_INVALID",
      });
    }
    socket.emit("confirm-read", {
      senderId,
      userId: userIdFromPayload,
    });
  }

  /**
   * Process `delete_for_me` via HTTP PATCH. Returns the parsed response
   * (the controller responds with `{ success, messageId }`).
   *
   * @param {ReturnType<typeof decodeRow>} item
   */
  async function processDeleteForMe(item) {
    if (apiClient == null) {
      throw Object.assign(new Error("API_CLIENT_MISSING"), {
        code: "API_CLIENT_MISSING",
      });
    }
    const messageId =
      typeof item.payload.messageId === "string"
        ? item.payload.messageId
        : null;
    if (messageId == null) {
      throw Object.assign(new Error("MESSAGE_ID_MISSING"), {
        code: "MESSAGE_ID_MISSING",
      });
    }
    return apiClient.patch(
      `${messagesRoute}/${messageId}/delete-for-me`,
      {},
      { withCredentials: true },
    );
  }

  /**
   * Process `delete_for_everyone` via HTTP PATCH. The repository handles
   * the 403-revert case in a follow-up task; here we just propagate the
   * HTTP error so the queue can decide retry vs. fail.
   *
   * @param {ReturnType<typeof decodeRow>} item
   */
  async function processDeleteForEveryone(item) {
    if (apiClient == null) {
      throw Object.assign(new Error("API_CLIENT_MISSING"), {
        code: "API_CLIENT_MISSING",
      });
    }
    const messageId =
      typeof item.payload.messageId === "string"
        ? item.payload.messageId
        : null;
    if (messageId == null) {
      throw Object.assign(new Error("MESSAGE_ID_MISSING"), {
        code: "MESSAGE_ID_MISSING",
      });
    }
    return apiClient.patch(
      `${messagesRoute}/${messageId}/delete-for-everyone`,
      {},
      { withCredentials: true },
    );
  }

  /**
   * Dispatch a single in-flight item to the kind-specific driver.
   *
   * @param {ReturnType<typeof decodeRow>} item
   * @returns {Promise<unknown>}
   */
  async function dispatchItem(item) {
    switch (item.kind) {
      case "send_text":
        return processMessageEmit(item);
      case "send_file":
        return processSendFile(item);
      case "mark_read":
        return processMarkRead(item);
      case "delete_for_me":
        return processDeleteForMe(item);
      case "delete_for_everyone":
        return processDeleteForEveryone(item);
      default:
        throw Object.assign(new Error("UNKNOWN_KIND"), {
          code: "UNKNOWN_KIND",
          kind: item.kind,
        });
    }
  }

  // ----- Drain loop -------------------------------------------------------

  /**
   * Drain the queue until no due item remains. Single-flight: a concurrent
   * `drain()` call sets `drainPending` and returns immediately; the loop
   * picks the pending flag up after the current pass completes so a burst
   * of `triggerDrain` calls collapses to one fresh pass.
   *
   * Drain ALWAYS releases the in-flight guard in `finally` so a thrown
   * dispatch error cannot wedge the queue (Req 6.9).
   *
   * @returns {Promise<void>}
   */
  async function drain() {
    if (!repository.isReady()) return;
    if (!isOnline()) return;
    if (drainInFlight) {
      drainPending = true;
      return;
    }
    drainInFlight = true;
    try {
      while (true) {
        const headRow = await readDrainHead();
        if (headRow == null) break;
        const item = decodeRow(headRow);

        if (kindRequiresSocket(item.kind)) {
          if (socket == null || socket.connected === false) {
            // Socket not ready — leave the row queued so a connectivity
            // transition will retry it.
            break;
          }
        }

        const claimed = await markInFlight(item.id);
        if (!claimed) {
          // Lost the race (shouldn't happen with the single-flight guard,
          // but defensive): try the next head on the next iteration.
          continue;
        }

        try {
          const result = await dispatchItem(item);
          // Confirmation path. For socket-bound message kinds, the result
          // is the server payload returned by the deferred. For HTTP kinds
          // and `mark_read`, we synthesize an empty payload — the
          // repository's `markOutboundConfirmed` accepts a missing
          // `serverMessage` and just flips the queue row.
          await repository.markOutboundConfirmed({
            queueId: item.id,
            serverMessage:
              result != null && typeof result === "object"
                ? /** @type {unknown} */ (result)
                : undefined,
          });
        } catch (err) {
          const attempts = item.attempts + 1;
          const errMessage = describeRouteError(err);
          if (attempts >= maxAttempts) {
            await repository.markOutboundFailed({
              queueId: item.id,
              error: errMessage,
            });
          } else {
            const delayMs = computeBackoffMs(attempts);
            await rescheduleBackoff(item.id, attempts, errMessage, delayMs);
          }
          // Continue draining other items even after a single failure —
          // a stuck item should not block items behind it indefinitely.
        }
      }
    } finally {
      drainInFlight = false;
      if (drainPending) {
        drainPending = false;
        // Schedule another pass on a microtask boundary so we do not
        // recurse synchronously and grow the call stack.
        setTimeoutFn(() => {
          drain().catch(() => {});
        }, 0);
      }
    }
  }

  /**
   * Fire-and-forget drain trigger. Swallows errors so callers (socket
   * handlers, connectivity listeners) cannot accidentally wedge.
   *
   * @returns {void}
   */
  function triggerDrain() {
    drain().catch((err) => {
      diagnostics.log({
        category: "outbound",
        code: "OUTBOUND_DRAIN_FAILED",
        outcome: "error",
        meta: { reason: describeRouteError(err) },
      });
    });
  }

  // ----- Lifecycle --------------------------------------------------------

  async function start() {
    if (started) return;
    started = true;
    // Boot rollback (Req 6.9): any rows still in `in_flight` from the
    // previous process did not actually complete — flip them back to
    // `queued` so the drain pass can replay them.
    try {
      await rollbackInFlight({ stuckOnly: false });
    } catch (err) {
      diagnostics.log({
        category: "outbound",
        code: "OUTBOUND_ROLLBACK_FAILED",
        outcome: "error",
        meta: { reason: describeRouteError(err) },
      });
    }
    // Subscribe to connectivity transitions (Req 11.5).
    if (connectivity != null) {
      connectivityUnsub = connectivity.subscribe((state) => {
        if (state === "online") triggerDrain();
      });
    }
    // 60s timer covers due-by-`next_attempt_at` retries and stuck
    // `in_flight` rows.
    timerHandle = setIntervalFn(() => {
      rollbackInFlight({ stuckOnly: true })
        .then(() => triggerDrain())
        .catch(() => {});
    }, timerIntervalMs);
    // Initial drain pass once everything is wired up.
    triggerDrain();
  }

  async function stop() {
    if (!started) return;
    started = false;
    try {
      connectivityUnsub();
    } catch {
      // ignore
    }
    connectivityUnsub = () => {};
    if (timerHandle != null) {
      clearIntervalFn(timerHandle);
      timerHandle = null;
    }
    drainPending = false;
  }

  /**
   * @param {OutboundSocket | null} nextSocket
   */
  function setSocket(nextSocket) {
    socket = nextSocket;
  }

  /**
   * Convenience wrapper that calls `repository.enqueueOutbound` and then
   * fires a drain (Req 6.7 / §3.4 "Every `enqueueOutbound` while online").
   *
   * @param {{ kind: OutboundKind, conversationId: string, conversationType: "dm"|"channel", payload?: Record<string, unknown>, localFilePath?: string | null, clientTempId?: string }} args
   */
  async function enqueue(args) {
    const result = await repository.enqueueOutbound(args);
    if (started) triggerDrain();
    return result;
  }

  function isDraining() {
    return drainInFlight;
  }

  return {
    start,
    stop,
    drain,
    triggerDrain,
    enqueue,
    setSocket,
    isDraining,
  };
}

// ---------------------------------------------------------------------------
// Internal: error description (kept local to avoid a cycle with repository)
// ---------------------------------------------------------------------------

/**
 * Best-effort string description of an error or a non-error rejection.
 * Mirrors `describeError` in `repositories/index.js` but is a separate
 * function so this module stays a pure leaf in the dependency graph.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeRouteError(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err.slice(0, 200);
  if (err instanceof Error) {
    return (err.message || err.name || "error").slice(0, 200);
  }
  try {
    const out = JSON.stringify(err);
    return typeof out === "string" ? out.slice(0, 200) : "unprintable";
  } catch {
    try {
      return String(err).slice(0, 200);
    } catch {
      return "unprintable";
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (lazy, opt-in)
// ---------------------------------------------------------------------------

/** @type {OutboundQueue | null} */
let singleton = null;

/**
 * Lazily-initialized OutboundQueue used by {@link OfflineProvider}.
 * `init` MUST supply the wiring on first call; subsequent calls return
 * the existing instance.
 *
 * @param {OutboundQueueOptions} [init]
 * @returns {OutboundQueue}
 */
export function getOutboundQueue(init) {
  if (singleton == null) {
    if (init == null || init.repository == null) {
      throw new Error(
        "getOutboundQueue: first call must supply the repository wiring",
      );
    }
    singleton = createOutboundQueue(init);
  }
  return singleton;
}

/**
 * Reset the module-level singleton. Test-only.
 *
 * @internal
 */
export function __resetOutboundQueueSingletonForTests() {
  singleton = null;
}
