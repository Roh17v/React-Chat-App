/**
 * OfflineProvider — React glue that wires the offline layer onto the live
 * UI. Mounted between `<SocketProvider>` and `<App />` (task 16.3, design
 * §3.12).
 *
 * Responsibilities:
 *   - On `user` set: open the local DB, hydrate `useAppStore` from the
 *     repository, start the {@link SyncEngine}, wire {@link Connectivity}
 *     to the live socket, and start {@link MediaCache} +
 *     {@link OutboundQueue}. On any failure, flip
 *     `useAppStore.offlineMode` to `"unavailable"` so the banner can
 *     render and the existing online-only flow keeps working (Req 2.5).
 *   - On `user` cleared: stop every subsystem, then `repository.wipe()`,
 *     then `EncryptionLayer.destroy()`. Order matters: the wipe writes
 *     encrypted bytes when deleting rows, so the key must still be
 *     reachable when the wipe runs (Req 1.6 / 10.6).
 *   - User-switch (`meta.user_id !== currentUserId`) is handled inside
 *     `repository.init({ userId })` — when the persisted user_id differs
 *     it wipes the local DB before persisting the new user_id (§Migration
 *     plan). The provider just calls `init` and trusts the repository to
 *     do the right thing; the empty `sync_cursors` table that follows
 *     causes `SyncEngine.start` to run a fresh bootstrap.
 *   - Bridges {@link Connectivity}'s derived state into
 *     `useAppStore.connectivity` (Req 11.1 / 11.2 / 11.3 / 11.5).
 *
 * Web build: this release targets Android Capacitor only (design overview
 * + Req 2.2). On non-native platforms the provider sets
 * `offlineMode = "unavailable"` and skips the offline subsystems entirely
 * so vite dev / preview keeps working unchanged.
 *
 * Implements task 16.2 of `.kiro/specs/offline-support/tasks.md`.
 *
 * Validates: Requirements 1.1, 1.2, 1.6, 2.5, 4.1, 4.2, 5.1, 5.2, 10.6,
 * 11.1, 11.5.
 *
 * @module offline/OfflineProvider
 */

import { useEffect, useRef } from "react";
import axios from "axios";
import { Capacitor } from "@capacitor/core";

import useAppStore from "../store/index.js";
import { useSocket } from "../context/SocketContext.jsx";

import { getRepository } from "./repositories/index.js";
import { getSyncEngine } from "./sync/SyncEngine.js";
import { getOutboundQueue } from "./sync/OutboundQueue.js";
import { getConnectivity } from "./services/Connectivity.js";
import { getMediaCache } from "./services/MediaCache.js";
import { getEncryptionLayer } from "./services/EncryptionLayer.js";
import { getDiagnostics } from "./utils/Diagnostics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How often to poll the SyncEngine status into the UI slice. The engine
 * does not currently expose a subscription API; a 1s poll is cheap (no
 * SQL, just a property read) and gives the "Syncing..." pill a snappy
 * enough refresh cadence (Req 4.2 / 11.3).
 */
const STATUS_POLL_MS = 1_000;

/**
 * How often to refresh `outboundQueueLength` from the repository. Two
 * seconds is conservative — the value changes only when the user composes
 * a message offline or the queue drains, and the diagnostics screen reads
 * the same number.
 */
const QUEUE_POLL_MS = 2_000;

/**
 * Map the {@link SyncEngine} internal phase onto the OfflineSlice
 * `bootstrapStatus` enum. The engine reports a richer phase set
 * (`idle | bootstrap | incremental | ready | degraded`); the UI slice
 * uses the smaller `idle | running | ready | partial` enum from
 * §Components — this keeps the UI binding stable when the engine adds
 * new internal phases.
 */
const PHASE_TO_BOOTSTRAP = Object.freeze({
  idle: "idle",
  bootstrap: "running",
  incremental: "running",
  ready: "ready",
  degraded: "partial",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort error description that never throws. Used purely for
 * diagnostic logging — the offline layer must never let a broken stub
 * value bring down the boot path.
 *
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Render-only provider. Mounts the offline layer in a single `useEffect`
 * keyed on `user?.id` (so a user-switch tears down + reboots), plus two
 * polling effects for status + queue length. Renders `children` directly;
 * no DOM wrapper is added (the design places the provider above
 * `<App />` so any wrapper would alter the layout).
 *
 * @param {{ children?: import("react").ReactNode }} props
 */
export function OfflineProvider({ children }) {
  // ----- Store bindings --------------------------------------------------
  // Pull each setter individually so a slice change in an unrelated
  // setter does not re-run the lifecycle effect.
  const user = useAppStore((s) => s.user);
  const setConnectivity = useAppStore((s) => s.setConnectivity);
  const setBootstrapStatus = useAppStore((s) => s.setBootstrapStatus);
  const setOutboundQueueLength = useAppStore((s) => s.setOutboundQueueLength);
  const setOfflineMode = useAppStore((s) => s.setOfflineMode);
  const setLocalEncryption = useAppStore((s) => s.setLocalEncryption);
  const setLastIncrementalSyncAt = useAppStore(
    (s) => s.setLastIncrementalSyncAt,
  );
  const setDirectMessagesContacts = useAppStore(
    (s) => s.setDirectMessagesContacts,
  );
  const setChannels = useAppStore((s) => s.setChannels);
  const setIsInitialized = useAppStore((s) => s.setIsInitialized);
  const resetOfflineSlice = useAppStore((s) => s.resetOfflineSlice);

  // SocketContext.Provider value: `{ socket, onlineUsers }`. `socket` is
  // the raw socket.io client; we forward it to Connectivity which
  // subscribes to its `connect` / `disconnect` events.
  const socketCtx = useSocket();
  const socket =
    socketCtx != null && typeof socketCtx === "object" && "socket" in socketCtx
      ? /** @type {{ socket: unknown }} */ (socketCtx).socket
      : null;

  // ----- Lifecycle refs --------------------------------------------------
  /**
   * Mutable handles owned across renders. Storing the constructed
   * subsystem references here means teardown can find them even when the
   * boot promise hasn't resolved (early-cancel case).
   *
   * @type {React.MutableRefObject<{
   *   started: boolean,
   *   repo: ReturnType<typeof getRepository> | null,
   *   syncEngine: ReturnType<typeof getSyncEngine> | null,
   *   outboundQueue: ReturnType<typeof getOutboundQueue> | null,
   *   connectivity: ReturnType<typeof getConnectivity> | null,
   *   mediaCache: ReturnType<typeof getMediaCache> | null,
   *   encryption: ReturnType<typeof getEncryptionLayer> | null,
   *   connectivityUnsub: (() => void) | null,
   *   statusInterval: ReturnType<typeof setInterval> | null,
   *   queueInterval: ReturnType<typeof setInterval> | null,
   * }>}
   */
  const refs = useRef({
    started: false,
    repo: null,
    syncEngine: null,
    outboundQueue: null,
    connectivity: null,
    mediaCache: null,
    encryption: null,
    connectivityUnsub: null,
    statusInterval: null,
    queueInterval: null,
  });

  // ----- Lifecycle effect (boot / teardown) -----------------------------
  useEffect(() => {
    const userId =
      user != null && typeof user === "object" && typeof user.id === "string"
        ? user.id
        : null;

    // Logout / not yet logged in: nothing to mount. Cleanup of a previous
    // session ran when the previous effect's cleanup fired, before this
    // body re-evaluated.
    if (userId == null) {
      return undefined;
    }

    // Web / non-native: keep the existing online-only flow. The banner
    // copy in 16.9 reads `offlineMode === "unavailable"`.
    if (!Capacitor.isNativePlatform()) {
      try {
        setOfflineMode("unavailable");
      } catch {
        // Swallow — the slice's own setter is robust, but if the store
        // is somehow unavailable we continue without the banner.
      }
      return undefined;
    }

    // Wait until the SocketProvider has assigned its `socket.current`.
    // The provider re-renders when `useSocket()` returns a non-null
    // socket, at which point this effect re-runs with the live ref.
    if (socket == null) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      await boot(userId, /** @type {any} */ (socket));
      if (cancelled) {
        // The user logged out (or swapped) before boot finished. Tear
        // down whatever we managed to start — the cleanup function
        // below will already have run by this point, but our refs are
        // populated, so a manual teardown ensures nothing is left
        // running.
        await teardown();
      }
    })();

    return () => {
      cancelled = true;
      // Tear down asynchronously. We do not await here (React's effect
      // cleanup is sync) but the chain runs to completion before any
      // subsequent boot fires because the next effect body checks
      // `refs.current.started` and returns immediately if a teardown is
      // mid-flight.
      void teardown().then(() => {
        try {
          resetOfflineSlice();
        } catch {
          // The slice exposes its own validation; this catch is purely
          // defensive against a missing setter in tests.
        }
      });
    };
  }, [user?.id, socket]);

  // The provider has no DOM of its own — wrapping `<children />` in any
  // element would risk altering an ancestor's layout. Returning the
  // children directly keeps the provider purely a side-effect component.
  return /** @type {any} */ (children) ?? null;

  // ----- Boot ----------------------------------------------------------

  /**
   * Run the cold-start sequence (§3.12). Resolves true on success, false
   * on any failure that flipped `offlineMode = "unavailable"`.
   *
   * @param {string} userId
   * @param {{ on: (event: string, listener: (...args: unknown[]) => void) => unknown, off: (event: string, listener: (...args: unknown[]) => void) => unknown, connected?: boolean }} liveSocket
   * @returns {Promise<boolean>}
   */
  async function boot(userId, liveSocket) {
    if (refs.current.started) {
      // Idempotent — a second boot for the same user is a no-op.
      return true;
    }
    refs.current.started = true;
    const diagnostics = getDiagnostics();

    // 1. Repository init — opens the SQLite connection, runs migrations,
    //    detects user-switch internally and wipes if necessary
    //    (§Migration plan). On failure flip `offlineMode` so the UI
    //    surfaces the banner and the rest of the app keeps working
    //    online-only (Req 2.5).
    const repo = getRepository();
    refs.current.repo = repo;
    let initResult;
    try {
      initResult = await repo.init({ userId });
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "OFFLINE_PROVIDER_INIT_THREW",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
      try {
        setOfflineMode("unavailable");
      } catch {
        // Swallow.
      }
      return false;
    }
    if (initResult == null || initResult.ok !== true) {
      const reason =
        initResult != null &&
        initResult.ok === false &&
        typeof initResult.reason === "string"
          ? initResult.reason
          : "UNKNOWN";
      diagnostics.log({
        category: "boot",
        code: "OFFLINE_PROVIDER_INIT_FAILED",
        outcome: "error",
        meta: { reason },
      });
      try {
        setOfflineMode("unavailable");
      } catch {
        // Swallow.
      }
      return false;
    }

    try {
      setOfflineMode("available");
    } catch {
      // Swallow.
    }

    // 2. Mirror the encryption mode the layer settled on. The layer's
    //    `diagnoseAvailability()` is a non-throwing probe — when the
    //    secret store is unreachable it returns `{ available: false }`
    //    and `repository.init` already opened the DB unencrypted with
    //    `local_encryption = "none"` (Req 10.4).
    const encryption = getEncryptionLayer();
    refs.current.encryption = encryption;
    try {
      const avail = await encryption.diagnoseAvailability();
      setLocalEncryption(
        avail != null && avail.available === true ? "secure" : "none",
      );
    } catch (err) {
      diagnostics.log({
        category: "encryption",
        code: "OFFLINE_PROVIDER_DIAGNOSE_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
      setLocalEncryption("none");
    }

    // 3. Hydrate the UI slice from the local DB. These reads are
    //    intentionally serial — both are tiny (<1ms each on a warm DB)
    //    and parallelizing them would not change perceived latency.
    //    Failures are non-fatal; the network-driven existing flow will
    //    refill the slice once SyncEngine kicks off below.
    try {
      const contacts = await repo.getContacts();
      setDirectMessagesContacts(contacts);
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "OFFLINE_PROVIDER_HYDRATE_CONTACTS_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }
    try {
      const channels = await repo.getChannels();
      setChannels(channels);
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "OFFLINE_PROVIDER_HYDRATE_CHANNELS_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }

    try {
      setIsInitialized(true);
    } catch {
      // Swallow.
    }

    // 4. MediaCache singleton. Construction needs the repo on the very
    //    first call; subsequent calls receive the same instance regardless
    //    of the arg. We hold the reference in a ref so teardown can call
    //    `.stop()` on the exact instance we started.
    try {
      const mediaCache = getMediaCache({ repository: repo });
      refs.current.mediaCache = mediaCache;
      mediaCache.start();
    } catch (err) {
      diagnostics.log({
        category: "media",
        code: "OFFLINE_PROVIDER_MEDIA_START_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }

    // 5. Connectivity. Subscribe to the slice mirror BEFORE start so the
    //    very first emission lands. The OutboundQueue and SyncEngine
    //    fan-outs are wired below via `setFanoutTargets` once both are
    //    constructed.
    const connectivity = getConnectivity();
    refs.current.connectivity = connectivity;
    refs.current.connectivityUnsub = connectivity.subscribe((state) => {
      try {
        setConnectivity(state);
      } catch {
        // Swallow.
      }
    });

    // 6. OutboundQueue singleton. Construction wires the repository,
    //    socket, axios, and connectivity so the queue can drain on
    //    `online` transitions (Req 6.7 / 11.5).
    let outboundQueue = null;
    try {
      outboundQueue = getOutboundQueue({
        repository: repo,
        socket: liveSocket,
        apiClient: /** @type {any} */ (axios),
        connectivity,
      });
      refs.current.outboundQueue = outboundQueue;
    } catch (err) {
      diagnostics.log({
        category: "outbound",
        code: "OFFLINE_PROVIDER_OUTBOUND_INIT_FAILED",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
    }

    // 7. SyncEngine singleton. Construction needs only the repository
    //    and apiClient; the engine reads cursors from the repo and
    //    decides between bootstrap and incremental in `start()`.
    let syncEngine = null;
    try {
      syncEngine = getSyncEngine({
        repository: /** @type {any} */ (repo),
        apiClient: /** @type {any} */ (axios),
      });
      refs.current.syncEngine = syncEngine;
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "OFFLINE_PROVIDER_SYNC_INIT_FAILED",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
    }

    // 8. Start Connectivity now that both downstream consumers exist.
    //    `start(socket)` returns synchronously and may emit the initial
    //    derived state through the listener registered above.
    try {
      connectivity.start(liveSocket);
      // Mirror the immediate value too — Connectivity does not invoke
      // listeners synchronously on subscribe (by design), so we read
      // `current()` once after start to seed the slice.
      try {
        setConnectivity(connectivity.current());
      } catch {
        // Swallow.
      }
    } catch (err) {
      diagnostics.log({
        category: "live",
        code: "OFFLINE_PROVIDER_CONNECTIVITY_START_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }

    // 9. Wire fan-out so connectivity transitions reach the queue and
    //    the engine. Both subsystems also subscribe directly to
    //    Connectivity for their own purposes; `setFanoutTargets` covers
    //    the operational hooks called out in §3.9.
    try {
      connectivity.setFanoutTargets({
        outboundQueue: /** @type {any} */ (outboundQueue),
        syncEngine: /** @type {any} */ (syncEngine),
      });
    } catch {
      // Swallow — fan-out is optional.
    }

    // 10. Start the queue, then the engine. Engine `start()` is
    //     partially blocking: on a warm boot it awaits the first
    //     incremental pass (~200-500ms) so the sidebar paints with
    //     fresh unread counts / `last_message` previews; on a cold
    //     boot it fires bootstrap in the background (Req 4.2 — UI must
    //     not block on bootstrap) because the local DB is empty and a
    //     cold bootstrap can take 10+ seconds.
    if (outboundQueue != null) {
      try {
        await outboundQueue.start();
      } catch (err) {
        diagnostics.log({
          category: "outbound",
          code: "OFFLINE_PROVIDER_OUTBOUND_START_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }
    if (syncEngine != null) {
      try {
        await syncEngine.start({ userId });
      } catch (err) {
        diagnostics.log({
          category: "boot",
          code: "OFFLINE_PROVIDER_SYNC_START_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }

    // 11. Status / queue-length poll loops. Both are timer-based because
    //     SyncEngine and OutboundQueue do not currently expose change
    //     subscriptions. The pollers are cheap — `getStatus()` is a
    //     property read and the queue-length query is a single COUNT(*)
    //     against an indexed table. If we add a subscription API later
    //     we can drop these in a follow-up without changing the slice.
    refs.current.statusInterval = setInterval(() => {
      const engine = refs.current.syncEngine;
      if (engine == null) return;
      try {
        const status = engine.getStatus();
        // The slice's `bootstrapStatus` is the user-visible flag —
        // prefer the engine's `bootstrapStatus` when it's `partial`
        // (Req 4.5) so the UI surfaces the partial-bootstrap toast,
        // otherwise derive from `phase`.
        const next =
          status.bootstrapStatus === "partial"
            ? "partial"
            : (PHASE_TO_BOOTSTRAP[status.phase] || "idle");
        try {
          setBootstrapStatus(next);
        } catch {
          // Swallow.
        }
        try {
          setLastIncrementalSyncAt(status.lastIncrementalSyncAt ?? null);
        } catch {
          // Swallow.
        }
      } catch {
        // Swallow — getStatus() is synchronous and read-only, but a
        // future refactor could change that.
      }
    }, STATUS_POLL_MS);

    refs.current.queueInterval = setInterval(() => {
      const r = refs.current.repo;
      if (r == null) return;
      void (async () => {
        try {
          const items = await r.getOutboundQueue();
          setOutboundQueueLength(Array.isArray(items) ? items.length : 0);
        } catch {
          // Swallow.
        }
      })();
    }, QUEUE_POLL_MS);

    diagnostics.log({
      category: "boot",
      code: "OFFLINE_PROVIDER_BOOTED",
      outcome: "ok",
      meta: { userId },
    });

    return true;
  }

  // ----- Teardown ------------------------------------------------------

  /**
   * Reverse of {@link boot}. Stop order is fixed (§3.12): SyncEngine →
   * MediaCache → Connectivity → OutboundQueue → repository.wipe →
   * EncryptionLayer.destroy. Wipe MUST run before destroy because the
   * SQLCipher delete writes encrypted bytes (Req 1.6 / 10.6).
   *
   * Errors from any step are swallowed and logged — teardown's job is
   * to release resources, never to throw.
   *
   * @returns {Promise<void>}
   */
  async function teardown() {
    if (!refs.current.started) return;
    refs.current.started = false;
    const diagnostics = getDiagnostics();

    // Cancel the polling timers first so a tick mid-teardown doesn't
    // touch an instance we're about to stop.
    if (refs.current.statusInterval != null) {
      try {
        clearInterval(refs.current.statusInterval);
      } catch {
        // Swallow.
      }
      refs.current.statusInterval = null;
    }
    if (refs.current.queueInterval != null) {
      try {
        clearInterval(refs.current.queueInterval);
      } catch {
        // Swallow.
      }
      refs.current.queueInterval = null;
    }

    // 1. SyncEngine — owns the in-flight sync promises; stop first so
    //    no new repository writes are queued during the wipe below.
    if (refs.current.syncEngine != null) {
      try {
        await refs.current.syncEngine.stop();
      } catch (err) {
        diagnostics.log({
          category: "boot",
          code: "OFFLINE_PROVIDER_SYNC_STOP_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }

    // 2. MediaCache — owns the eviction interval. Stopping it before
    //    the repository wipe means we won't try to delete files via a
    //    lookup against the (about-to-be-empty) media_cache table.
    if (refs.current.mediaCache != null) {
      try {
        refs.current.mediaCache.stop();
      } catch (err) {
        diagnostics.log({
          category: "media",
          code: "OFFLINE_PROVIDER_MEDIA_STOP_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }

    // 3. Connectivity — drop the socket / network listeners and clear
    //    the fan-out so any final state change does not race the
    //    sync/queue stops above.
    if (refs.current.connectivityUnsub != null) {
      try {
        refs.current.connectivityUnsub();
      } catch {
        // Swallow.
      }
      refs.current.connectivityUnsub = null;
    }
    if (refs.current.connectivity != null) {
      try {
        refs.current.connectivity.stop();
      } catch (err) {
        diagnostics.log({
          category: "live",
          code: "OFFLINE_PROVIDER_CONNECTIVITY_STOP_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }

    // 4. OutboundQueue — owns the drain timer + the in-flight emit
    //    deferreds. Stop after Connectivity so the `online` listener
    //    can no longer trigger drain.
    if (refs.current.outboundQueue != null) {
      try {
        await refs.current.outboundQueue.stop();
      } catch (err) {
        diagnostics.log({
          category: "outbound",
          code: "OFFLINE_PROVIDER_OUTBOUND_STOP_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }

    // 5. Wipe local DB content + media directory. Must happen BEFORE
    //    EncryptionLayer.destroy() because the SQLCipher delete still
    //    needs the key (Req 1.6 / 10.6).
    if (refs.current.repo != null) {
      try {
        await refs.current.repo.wipe();
      } catch (err) {
        diagnostics.log({
          category: "boot",
          code: "OFFLINE_PROVIDER_WIPE_FAILED",
          outcome: "error",
          meta: { reason: describeError(err) },
        });
      }
    }

    // 6. Destroy the encryption secret (Req 10.6). After this returns,
    //    `sqlite.isSecretStored()` is false; a future re-init for any
    //    user generates a fresh 32-byte key.
    if (refs.current.encryption != null) {
      try {
        await refs.current.encryption.destroy();
      } catch (err) {
        diagnostics.log({
          category: "encryption",
          code: "OFFLINE_PROVIDER_ENCRYPTION_DESTROY_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }

    // Drop our refs so a subsequent boot starts clean.
    refs.current.repo = null;
    refs.current.syncEngine = null;
    refs.current.outboundQueue = null;
    refs.current.connectivity = null;
    refs.current.mediaCache = null;
    refs.current.encryption = null;

    diagnostics.log({
      category: "boot",
      code: "OFFLINE_PROVIDER_TORN_DOWN",
      outcome: "ok",
    });
  }
}

export default OfflineProvider;
