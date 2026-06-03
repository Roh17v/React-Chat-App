// @ts-check
/**
 * Tiny shared utilities for the bootstrap / incremental helpers and the
 * orchestrating {@link createSyncEngine}. Kept in a sibling module so
 * the helpers stay free of cross-imports back into `SyncEngine.js`.
 *
 * @module offline/sync/syncHelpers
 */

/**
 * Default sleep implementation. Resolves after `ms` milliseconds using
 * `setTimeout`. Tests inject a no-op so retries run synchronously.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function defaultSleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Render an arbitrary error-ish value into a short human string suitable
 * for diagnostics metadata. Truncates to 200 characters so a runaway
 * error message can never blow out the ring buffer.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
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
 * Coerce an arbitrary value to a non-empty string id, or `null` when the
 * value is missing / not stringy. Accepts both the bare `string` form
 * (`"abc"`) and the populated subdocument form (`{ _id: "abc", ... }`)
 * the backend returns from `populate()`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function asId(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const inner = /** @type {{ _id?: unknown }} */ (value)._id;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return null;
}
