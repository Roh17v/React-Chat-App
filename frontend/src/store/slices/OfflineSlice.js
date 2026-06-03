/**
 * OfflineSlice — Zustand slice that mirrors the offline-layer status onto the
 * UI store so React components can read connectivity, bootstrap progress, and
 * diagnostics without reaching into `frontend/src/offline/` directly.
 *
 * The slice is wired by `OfflineProvider` (Connectivity → `setConnectivity`,
 * SyncEngine status → `setBootstrapStatus` / `setLastIncrementalSyncAt`) and
 * by the diagnostics screen (`applyDiagnosticsSnapshot`). Initialization
 * failures from the offline layer flip `offlineMode` to `"unavailable"` and
 * surface the banner per Req 2.5.
 *
 * Validation rule across all setters: if the caller passes an out-of-domain
 * value, the existing state is preserved rather than overwritten with garbage.
 * That keeps a stray bad call from corrupting the UI state and matches the
 * "diagnostics never throws" stance in the rest of the offline layer.
 *
 * Implements task 16.1 of `.kiro/specs/offline-support/tasks.md`.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 14.2.
 *
 * @module store/slices/OfflineSlice
 */

const CONNECTIVITY_VALUES = Object.freeze(["online", "offline", "reconnecting"]);
const BOOTSTRAP_STATUS_VALUES = Object.freeze(["idle", "running", "ready", "partial"]);
const OFFLINE_MODE_VALUES = Object.freeze(["available", "unavailable"]);
const LOCAL_ENCRYPTION_VALUES = Object.freeze(["secure", "none"]);

/** Defaults exported for tests and `resetOfflineSlice`. */
export const OFFLINE_SLICE_DEFAULTS = Object.freeze({
  connectivity: "online",
  bootstrapStatus: "idle",
  outboundQueueLength: 0,
  offlineMode: "available",
  localEncryption: "secure",
  lastIncrementalSyncAt: null,
});

/**
 * @param {readonly string[]} allowed
 * @param {unknown} value
 * @returns {value is string}
 */
function isOneOf(allowed, value) {
  return typeof value === "string" && allowed.includes(value);
}

/**
 * Coerce an arbitrary input to a non-negative integer. Returns `null` if the
 * value can't be reasonably interpreted as a count (used by the queue-length
 * setter to drop bad inputs without writing them).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toNonNegativeInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
}

/**
 * Zustand slice creator. Same signature as the other slices in this folder —
 * `(set, get) => ({ ...state, ...setters })`. State keys are top-level so they
 * compose cleanly into the combined store via the spread in
 * `frontend/src/store/index.js`.
 *
 * @param {(partial: object | ((state: object) => object)) => void} set
 */
export const createOfflineSlice = (set) => ({
  ...OFFLINE_SLICE_DEFAULTS,

  /**
   * Set the derived connectivity state. Accepts only `"online" | "offline" |
   * "reconnecting"` (Req 11.1).
   *
   * @param {"online" | "offline" | "reconnecting"} state
   */
  setConnectivity: (state) => {
    if (!isOneOf(CONNECTIVITY_VALUES, state)) return;
    set({ connectivity: state });
  },

  /**
   * Set the bootstrap progress flag the UI reads to drive the global
   * "Syncing..." indicator (Req 4.2 / Req 4.6, surfaced via Req 11.3).
   * Accepts `"idle" | "running" | "ready" | "partial"`.
   *
   * @param {"idle" | "running" | "ready" | "partial"} status
   */
  setBootstrapStatus: (status) => {
    if (!isOneOf(BOOTSTRAP_STATUS_VALUES, status)) return;
    set({ bootstrapStatus: status });
  },

  /**
   * Mirror the queued-row count from the outbound queue compactor or a
   * Diagnostics snapshot. Clamps negatives to zero, floors fractions, and
   * silently drops `NaN` / non-numeric inputs.
   *
   * @param {number} n
   */
  setOutboundQueueLength: (n) => {
    const clamped = toNonNegativeInt(n);
    if (clamped === null) return;
    set({ outboundQueueLength: clamped });
  },

  /**
   * Flip the offline-layer availability flag. `"unavailable"` triggers the
   * banner per Req 2.5 (the offline layer failed to initialize on this
   * device).
   *
   * @param {"available" | "unavailable"} mode
   */
  setOfflineMode: (mode) => {
    if (!isOneOf(OFFLINE_MODE_VALUES, mode)) return;
    set({ offlineMode: mode });
  },

  /**
   * Mirror the encryption mode the offline layer settled on. `"none"` is the
   * fallback when the secure store is unavailable (Req 10.4).
   *
   * @param {"secure" | "none"} mode
   */
  setLocalEncryption: (mode) => {
    if (!isOneOf(LOCAL_ENCRYPTION_VALUES, mode)) return;
    set({ localEncryption: mode });
  },

  /**
   * Record the last successful incremental-sync wall-clock time (Req 5.8).
   * Accepts an ISO-8601 string or `null`.
   *
   * @param {string | null} iso
   */
  setLastIncrementalSyncAt: (iso) => {
    if (iso === null) {
      set({ lastIncrementalSyncAt: null });
      return;
    }
    if (typeof iso !== "string" || iso.length === 0) return;
    set({ lastIncrementalSyncAt: iso });
  },

  /**
   * Convenience setter wired to `Diagnostics.snapshot()`. Copies the fields
   * that overlap with this slice (`outboundQueueLength`, `localEncryption`)
   * and skips anything the snapshot doesn't carry or that has no
   * corresponding slice field. Silently no-ops on a non-object input — this
   * runs from the diagnostics screen and must never throw the UI.
   *
   * Validates: Requirement 14.2.
   *
   * @param {{ outboundQueueLength?: number, localEncryption?: "secure"|"none"|null }} snapshot
   */
  applyDiagnosticsSnapshot: (snapshot) => {
    if (snapshot == null || typeof snapshot !== "object") return;

    /** @type {Record<string, unknown>} */
    const next = {};

    if (Object.prototype.hasOwnProperty.call(snapshot, "outboundQueueLength")) {
      const clamped = toNonNegativeInt(snapshot.outboundQueueLength);
      if (clamped !== null) next.outboundQueueLength = clamped;
    }

    if (Object.prototype.hasOwnProperty.call(snapshot, "localEncryption")) {
      if (isOneOf(LOCAL_ENCRYPTION_VALUES, snapshot.localEncryption)) {
        next.localEncryption = snapshot.localEncryption;
      }
    }

    if (Object.keys(next).length === 0) return;
    set(next);
  },

  /**
   * Restore every offline-slice field to its default. Called on logout, after
   * `repository.wipe()` and `Encryption.destroy()`, so the UI starts the next
   * session from a clean status board.
   */
  resetOfflineSlice: () => set({ ...OFFLINE_SLICE_DEFAULTS }),
});

export default createOfflineSlice;
