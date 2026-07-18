/**
 * Status lifecycle helpers for the offline message layer.
 *
 * Implements §3.6 of the offline-support design and Requirements 7.5 / 7.6:
 *
 *   - `STATUS_RANK` / `rank()` define the linear order
 *     `failed < pending < sent < delivered < read`.
 *   - `monotonicMaxStatus(localStatus, serverStatus)` enforces the lifecycle:
 *     server-supplied updates are only accepted when they do not move a message
 *     backwards. The single sanctioned "decrease" is `failed → pending` (retry),
 *     which is naturally allowed because `rank(pending) > rank(failed)`.
 *
 * The module is pure: no SQLite, no I/O, no side effects beyond a Diagnostics
 * `log()` call when a backwards transition is dropped. It is exercised by the
 * conflict resolver (task 8.1) and the repository's `applyStatusUpdate`
 * (task 7.2).
 *
 * @module offline/sync/statusLifecycle
 */

import { getDiagnostics } from "../utils/Diagnostics.js";

/**
 * Canonical status values, in lifecycle order.
 *
 * `failed` sits at rank 0 so that any server-supplied status (`pending`,
 * `sent`, `delivered`, `read`) is treated as forward progress relative to
 * `failed`. This is what makes the `failed → pending` retry transition
 * sanctioned without requiring a special case.
 *
 * @type {Readonly<{ failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 }>}
 */
export const STATUS_RANK = Object.freeze({
  failed: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
});

/**
 * @typedef {"failed" | "pending" | "sent" | "delivered" | "read"} MessageStatus
 */

/**
 * Returns the rank of the given status. Unknown values map to `-1` so they
 * lose every comparison and `monotonicMaxStatus` will keep the local value.
 * Callers should always pass canonical statuses; the defensive branch exists
 * so a malformed server payload cannot demote an established local status.
 *
 * @param {string | null | undefined} status
 * @returns {number}
 */
export function rank(status) {
  if (status == null) return -1;
  const r = STATUS_RANK[status];
  return typeof r === "number" ? r : -1;
}

/**
 * Reconcile a server-supplied status against the current local status.
 *
 *   - If the server-supplied status would move a message backwards (lower rank
 *     than the local status) AND the local status is not `failed`, the update
 *     is dropped and `STATUS_BACKWARDS_IGNORED` is logged via Diagnostics
 *     (Req 7.6).
 *   - If the local status is `failed`, the server status always wins. This is
 *     the sanctioned `failed → pending` retry path (Req 7.5), and also covers
 *     `failed → sent / delivered / read` when a previously-failed send is
 *     later confirmed by the server.
 *   - Otherwise the server status wins (forward progress, or equal rank).
 *
 * The function never throws and never mutates its arguments.
 *
 * @param {MessageStatus | string | null | undefined} localStatus
 * @param {MessageStatus | string | null | undefined} serverStatus
 * @returns {MessageStatus | string}
 */
export function monotonicMaxStatus(localStatus, serverStatus) {
  // If we have no local row yet, the server value is authoritative.
  if (localStatus == null) return /** @type {string} */ (serverStatus);
  // If the server did not supply a status, keep what we have.
  if (serverStatus == null) return /** @type {string} */ (localStatus);

  const localRank = rank(localStatus);
  const serverRank = rank(serverStatus);

  // Backwards move attempted on a non-failed local row → drop and log.
  if (serverRank < localRank && localStatus !== "failed") {
    try {
      getDiagnostics().log({
        category: "live",
        code: "STATUS_BACKWARDS_IGNORED",
        outcome: "warn",
        meta: { localStatus, serverStatus },
      });
    } catch {
      // Diagnostics must never affect the lifecycle decision.
    }
    return localStatus;
  }

  return serverStatus;
}
