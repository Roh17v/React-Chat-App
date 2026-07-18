// @ts-check
/**
 * Per-`clientTempId` deferred map.
 *
 * Implements the minimal contract that {@link createOutboundQueue} relies on
 * for `send_text` / `send_file` confirmation. Task 10.2 will refine this
 * (notably: the SyncEngine wiring that resolves the deferred when
 * `receiveMessage` arrives, the `messageSendFailed` rejection path, and any
 * cross-tab invalidation rules). The shape here is deliberately small so
 * task 10.2 does not have to rewrite the call sites in {@link OutboundQueue}.
 *
 * Contract:
 *
 *   register(clientTempId, { timeoutMs }?) → Promise<ServerMessage | null>
 *     - Resolves when {@link resolve} is called with the matching id.
 *     - Rejects when {@link reject} is called with the matching id, or when
 *       the optional timeout elapses (default 30s, matching §3.4).
 *     - Calling `register` for a `clientTempId` that already has a pending
 *       deferred replaces the previous one (the previous deferred is
 *       rejected with `REPLACED`). This matches the user-retry path
 *       (Req 6.6) where the OutboundQueue re-emits with the same
 *       `clientTempId` after a transient failure.
 *
 *   resolve(clientTempId, payload) / reject(clientTempId, error)
 *     - No-op when no deferred is registered for the id (the message
 *       arrived after the OutboundQueue gave up, for example).
 *
 * The registry is a pure in-process structure — no SQLite, no Capacitor
 * plugins. It is safe to import from tests.
 *
 * @module offline/sync/clientTempIdRegistry
 */

/**
 * @typedef {Object} ClientTempIdEntry
 * @property {(payload: unknown) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {ReturnType<typeof setTimeout> | null} timer
 */

/**
 * @typedef {Object} ClientTempIdRegistry
 * @property {(clientTempId: string, opts?: { timeoutMs?: number }) => Promise<unknown>} register
 *   Register a deferred for `clientTempId`. Returns a promise that settles
 *   when {@link resolve} or {@link reject} fires for the same id, or when
 *   the timeout elapses.
 * @property {(clientTempId: string, payload: unknown) => boolean} resolve
 *   Resolve a registered deferred with `payload`. Returns `true` when an
 *   entry was found and resolved, `false` otherwise.
 * @property {(clientTempId: string, error: Error | string) => boolean} reject
 *   Reject a registered deferred with `error`. Returns `true` when an
 *   entry was found and rejected, `false` otherwise.
 * @property {(clientTempId: string) => boolean} has
 * @property {() => number} _size
 *   Number of currently-pending deferreds. Exposed for tests.
 */

/**
 * Default timeout for `register({ timeoutMs })` when the caller does not
 * supply one — matches the 30s value called out in §3.4 of the design.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build a fresh registry instance. Tests should construct their own via
 * this factory; production code uses {@link getClientTempIdRegistry}.
 *
 * @param {{ defaultTimeoutMs?: number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [options]
 * @returns {ClientTempIdRegistry}
 */
export function createClientTempIdRegistry(options = {}) {
  const defaultTimeoutMs =
    typeof options.defaultTimeoutMs === "number" &&
    Number.isFinite(options.defaultTimeoutMs) &&
    options.defaultTimeoutMs > 0
      ? options.defaultTimeoutMs
      : DEFAULT_TIMEOUT_MS;
  const setTimeoutFn =
    typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimeoutFn =
    typeof options.clearTimeout === "function"
      ? options.clearTimeout
      : clearTimeout;

  /** @type {Map<string, ClientTempIdEntry>} */
  const pending = new Map();

  /**
   * @param {string} clientTempId
   * @returns {ClientTempIdEntry | undefined}
   */
  function take(clientTempId) {
    const entry = pending.get(clientTempId);
    if (entry == null) return undefined;
    pending.delete(clientTempId);
    if (entry.timer != null) clearTimeoutFn(entry.timer);
    return entry;
  }

  /**
   * @param {string} clientTempId
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<unknown>}
   */
  function register(clientTempId, opts) {
    if (typeof clientTempId !== "string" || clientTempId.length === 0) {
      return Promise.reject(
        Object.assign(new Error("clientTempId is required"), {
          code: "INVALID_CLIENT_TEMP_ID",
        }),
      );
    }
    const ms =
      opts != null &&
      typeof opts.timeoutMs === "number" &&
      Number.isFinite(opts.timeoutMs)
        ? opts.timeoutMs
        : defaultTimeoutMs;

    // If a deferred is already registered for this id, reject it with
    // `REPLACED` so the previous owner unwinds cleanly. This matches the
    // user-retry path (Req 6.6) where the OutboundQueue re-emits with the
    // same clientTempId after a transient failure.
    const existing = take(clientTempId);
    if (existing != null) {
      existing.reject(
        Object.assign(new Error("REPLACED"), { code: "REPLACED" }),
      );
    }

    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      if (ms > 0) {
        timer = setTimeoutFn(() => {
          // Only purge if we are still the registered entry — a concurrent
          // resolve()/reject() may have already cleared us.
          const cur = pending.get(clientTempId);
          if (cur != null && cur.resolve === resolve) {
            pending.delete(clientTempId);
          }
          reject(
            Object.assign(new Error("TIMEOUT"), {
              code: "TIMEOUT",
              clientTempId,
              timeoutMs: ms,
            }),
          );
        }, ms);
      }
      pending.set(clientTempId, { resolve, reject, timer });
    });
  }

  /**
   * @param {string} clientTempId
   * @param {unknown} payload
   * @returns {boolean}
   */
  function resolve(clientTempId, payload) {
    if (typeof clientTempId !== "string" || clientTempId.length === 0) {
      return false;
    }
    const entry = take(clientTempId);
    if (entry == null) return false;
    entry.resolve(payload);
    return true;
  }

  /**
   * @param {string} clientTempId
   * @param {Error | string} error
   * @returns {boolean}
   */
  function reject(clientTempId, error) {
    if (typeof clientTempId !== "string" || clientTempId.length === 0) {
      return false;
    }
    const entry = take(clientTempId);
    if (entry == null) return false;
    const err = error instanceof Error ? error : new Error(String(error));
    entry.reject(err);
    return true;
  }

  /**
   * @param {string} clientTempId
   * @returns {boolean}
   */
  function has(clientTempId) {
    return (
      typeof clientTempId === "string" &&
      clientTempId.length > 0 &&
      pending.has(clientTempId)
    );
  }

  return {
    register,
    resolve,
    reject,
    has,
    _size: () => pending.size,
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/** @type {ClientTempIdRegistry | null} */
let singleton = null;

/**
 * Process-wide registry used by the OutboundQueue and the SyncEngine.
 * Tests should construct their own via {@link createClientTempIdRegistry}.
 *
 * @returns {ClientTempIdRegistry}
 */
export function getClientTempIdRegistry() {
  if (singleton == null) {
    singleton = createClientTempIdRegistry();
  }
  return singleton;
}

/**
 * Reset the module-level singleton. Test-only.
 *
 * @internal
 */
export function __resetClientTempIdRegistryForTests() {
  singleton = null;
}
