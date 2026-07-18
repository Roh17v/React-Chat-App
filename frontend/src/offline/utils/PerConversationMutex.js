// @ts-check
/**
 * Per-conversation FIFO mutex (chained-promise pattern).
 *
 * Implements task 7.3 of the offline-support spec. The single-writer
 * guarantee called out in design §3.5 ("Single-writer serialization") and in
 * Req 5.6 / 5.7 is enforced through this tiny library: every repository
 * write that touches a conversation is dispatched through `acquire(convId)`
 * (or `withLock(convId, work)`), so concurrent `Incremental_Sync` and
 * `Live_Sync` writes for the same conversation cannot interleave and break
 * the single-row-per-`serverId` invariant (Req 9.7) — and they cannot
 * starve cross-conversation work either, because each conversation has its
 * own lock chain.
 *
 * The implementation is deliberately the same shape as the backend's
 * `withCallPairLock` (`backend/socket.js`): a `Map<key, Promise<void>>`
 * keyed by `conversationId`, plus the special `__global__` key for work
 * that does not belong to any one conversation (migrations, schema rebuild,
 * outbound queue head selection, cursor advance prior to a per-conversation
 * fan-in). Each `acquire` chains a fresh promise after the previous tail and
 * returns a release callback. When a key's lock chain is fully drained the
 * map entry is deleted to keep memory flat across long-running sessions.
 *
 * Design references:
 *   - §3.5 Per-conversation mutex and queueSeq generation
 *   - §3.3 Single-writer guarantee on every `applyXxx` repository method
 *   - Req 5.6 (interleaved Live + Incremental writes serialized)
 *   - Req 5.7 (no more than one Incremental_Sync per conversation in flight)
 *   - Backend reference pattern: `backend/socket.js` `withCallPairLock`.
 *
 * Notes / non-goals:
 *   - This is an in-process mutex. It does NOT coordinate across the
 *     Capacitor WebView and any background worker — there is none today,
 *     and the design does not introduce one. If a future iteration adds a
 *     background sync worker, that worker must talk to the repository via
 *     a message channel, not by opening a second SQLite connection.
 *   - The mutex orders task SUBMISSIONS in FIFO order. It does not impose
 *     fairness across keys — two `acquire("convA")` calls are ordered with
 *     respect to each other, and two `acquire("convB")` calls likewise, but
 *     `convA` and `convB` run independently.
 *   - `acquire` and `withLock` never throw. If the wrapped `work` rejects,
 *     `withLock` re-throws after releasing the lock so the caller's stack
 *     stays intact and the next queued task can run.
 *
 * @module offline/utils/PerConversationMutex
 */

/**
 * Reserved key used by global-scope work that should serialize against
 * every conversation's writer. The repository uses this key for outbound
 * queue head operations that are not conversation-scoped (drain head
 * selection, queue compaction) and for migrations that touch every
 * conversation. The literal string is part of the public contract so
 * tests and call sites do not have to import it.
 */
export const GLOBAL_MUTEX_KEY = "__global__";

/**
 * @typedef {Object} PerConversationMutex
 * @property {(key: string) => Promise<() => void>} acquire
 *   Acquire the lock for `key`. Resolves with a release callback once the
 *   previous holder for that key has released. Calling the release callback
 *   more than once is a no-op (the chain advanced on the first call).
 * @property {<T>(key: string, work: () => Promise<T> | T) => Promise<T>} withLock
 *   Convenience wrapper that acquires the lock, runs `work`, and releases
 *   in `finally`. Rejections from `work` propagate to the caller; the lock
 *   is always released.
 * @property {() => number} _activeKeyCount
 *   Number of keys currently holding a lock chain. Exposed for tests and
 *   for the leak-detector path in long-running diagnostics; production
 *   code should not branch on this value.
 */

/**
 * Build a fresh mutex instance. Each call returns an independent map, so
 * tests can construct isolated instances without resetting a singleton.
 *
 * @returns {PerConversationMutex}
 */
export function createPerConversationMutex() {
  /**
   * Tail of every key's lock chain. The value is the promise that will
   * resolve when the most-recently-acquired holder for that key releases.
   * A subsequent `acquire(key)` chains a fresh promise after this tail and
   * stores its own promise as the new tail, so calls form a strict FIFO
   * regardless of when their `await previous` settles.
   *
   * @type {Map<string, Promise<void>>}
   */
  const tails = new Map();

  /**
   * Normalize the key. We coerce `null` / `undefined` / non-string values
   * to {@link GLOBAL_MUTEX_KEY} so a buggy caller (e.g. an
   * `applyDeletion` that could not resolve the conversation) still
   * serializes against everything else rather than silently bypassing the
   * mutex. Empty strings are likewise treated as the global key — they
   * almost always indicate a missing conversationId at the call site.
   *
   * @param {unknown} key
   * @returns {string}
   */
  function normalizeKey(key) {
    if (typeof key !== "string" || key.length === 0) return GLOBAL_MUTEX_KEY;
    return key;
  }

  /**
   * @param {string} key
   * @returns {Promise<() => void>}
   */
  async function acquire(key) {
    const normalized = normalizeKey(key);
    const previous = tails.get(normalized) || Promise.resolve();

    /** @type {() => void} */
    let releaseCurrent = () => {};
    const current = /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        releaseCurrent = () => resolve();
      })
    );

    // Chain the new tail BEFORE awaiting the previous one so that any
    // subsequent `acquire` call this microtask sees us as the new tail and
    // queues behind us — preserving FIFO submission order even when many
    // callers pile in synchronously (e.g. a burst of `applyLiveMessage`
    // events arriving from socket.io in the same tick).
    tails.set(normalized, current);

    try {
      await previous;
    } catch {
      // The previous holder rejected internally and somehow leaked into
      // its own tail promise — should be impossible because we only ever
      // store resolve()-only promises here. Swallow defensively so a
      // single bad actor cannot poison the whole chain for this key.
    }

    let released = false;
    /** @returns {void} */
    function release() {
      if (released) return;
      released = true;
      releaseCurrent();
      // Clean up the map entry only if no one chained behind us. The
      // identity check is essential: another caller may have already
      // installed itself as the tail, and we must not delete THEIR
      // promise.
      if (tails.get(normalized) === current) {
        tails.delete(normalized);
      }
    }

    return release;
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T> | T} work
   * @returns {Promise<T>}
   */
  async function withLock(key, work) {
    const release = await acquire(key);
    try {
      return await work();
    } finally {
      release();
    }
  }

  return {
    acquire,
    withLock,
    _activeKeyCount: () => tails.size,
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/** @type {PerConversationMutex | null} */
let singleton = null;

/**
 * Process-wide mutex used by the repository. The repository creates the
 * singleton lazily on first use; tests should construct their own via
 * {@link createPerConversationMutex} so they get an isolated chain.
 *
 * @returns {PerConversationMutex}
 */
export function getPerConversationMutex() {
  if (singleton == null) {
    singleton = createPerConversationMutex();
  }
  return singleton;
}

/**
 * Reset the module-level singleton. Exported strictly for test setup.
 *
 * @internal
 */
export function __resetPerConversationMutexSingletonForTests() {
  singleton = null;
}
