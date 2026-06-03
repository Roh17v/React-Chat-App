// @ts-check
/**
 * Connectivity composition for the offline store.
 *
 * Implements §3.9 of the offline-support design and Requirements 11.1, 11.2,
 * 11.3, 11.4, and 11.5.
 *
 * Two sources feed the derived state:
 *   - `@capacitor/network`'s `Network.getStatus()` and the
 *     `networkStatusChange` event (radio-level reachability).
 *   - The existing socket.io socket's `connect`/`disconnect` events
 *     (application-level reachability to the chat backend).
 *
 * Derivation truth table (§3.9):
 *
 *   | network.connected | socket.connected | last socket event in 30s | derived       |
 *   | :---------------: | :--------------: | :----------------------: | :------------ |
 *   | true              | true             | any                      | `online`      |
 *   | true              | false            | none                     | `reconnecting`|
 *   | false             | *                | *                        | `offline`     |
 *
 * Property 20 collapses this to the simpler mapping:
 *   - `network.connected = false`                       → `offline`
 *   - `network.connected = true && socket.connected`    → `online`
 *   - `network.connected = true && !socket.connected`   → `reconnecting`
 *
 * The 30s socket-event window is tracked for diagnostics only — the derived
 * state is a pure function of the two boolean flags. Tracking the timestamp
 * still matters for Diagnostics so support can tell apart "socket disconnected
 * 2s ago" from "socket has been gone for an hour".
 *
 * Fan-out: every state change is forwarded to
 * {@link OutboundQueue#triggerDrain} (so queued items drain on `online`,
 * Req 11.5) and {@link SyncEngine#onConnectivityChange} (so incremental sync
 * runs on `online` and pauses on `offline`). External subscribers (the
 * `OfflineProvider` mirroring into `useAppStore`, Req 11.1 / 11.2 / 11.3)
 * register through {@link Connectivity.subscribe}.
 *
 * Non-native fallback: when `Capacitor.isNativePlatform()` returns false (vite
 * dev / jsdom tests / web build) the module falls back to `navigator.onLine`
 * plus `window.addEventListener('online' | 'offline')`. The socket portion of
 * the truth table works unchanged on every runtime.
 *
 * The factory is dependency-injected; {@link createConnectivity} accepts
 * `network`, `diagnostics`, `isNativePlatform`, and `now`/`setTimeoutFn` so
 * tests never touch the real Capacitor plugin. Production code uses
 * {@link getConnectivity} which binds the singletons.
 *
 * @module offline/services/Connectivity
 */

import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";

import { getDiagnostics } from "../utils/Diagnostics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Window of time after the last `connect`/`disconnect` event during which
 * we consider the socket "recently active". Tracked for diagnostics only —
 * the derived state itself does not depend on this value (see Property 20).
 */
export const SOCKET_EVENT_WINDOW_MS = 30_000;

/**
 * @typedef {"online" | "offline" | "reconnecting"} ConnectivityState
 */

/**
 * Subset of the socket.io-client `Socket` surface this module relies on.
 *
 * @typedef {Object} ConnectivitySocket
 * @property {boolean} [connected]
 * @property {(event: string, listener: (...args: unknown[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: unknown[]) => void) => unknown} off
 */

/**
 * Subset of the `@capacitor/network` Network surface used by this module. The
 * real plugin matches this shape; tests inject a stub that records the
 * `addListener` call and exposes a manual emit helper.
 *
 * @typedef {Object} NetworkPlugin
 * @property {() => Promise<{ connected: boolean, connectionType?: string }>} getStatus
 * @property {(event: "networkStatusChange", listener: (status: { connected: boolean, connectionType?: string }) => void) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> }} addListener
 */

/**
 * Targets the connectivity state changes are fanned out to.
 *
 * @typedef {Object} FanoutTargets
 * @property {{ triggerDrain?: () => void, drain?: () => Promise<void> }} [outboundQueue]
 * @property {{ onConnectivityChange?: (state: ConnectivityState) => void }} [syncEngine]
 */

/**
 * @typedef {Object} Connectivity
 * @property {(socket: ConnectivitySocket) => () => void} start
 *   Subscribe to the network plugin and the supplied socket. Returns an
 *   unsubscribe handle that detaches every listener (`stop()` is exposed
 *   separately for parity with other services). Idempotent: a second
 *   `start()` call with the same socket is a no-op; with a different socket
 *   the previous subscriptions are torn down first.
 * @property {() => ConnectivityState} current
 *   Synchronous read of the latest derived state. Always returns one of the
 *   three valid states; on the very first read (before `start()` resolves
 *   the initial `Network.getStatus()` call) returns the optimistic default
 *   inferred from `navigator.onLine` / `socket.connected`.
 * @property {(listener: (state: ConnectivityState) => void) => () => void} subscribe
 *   Register an external state-change listener. The listener is NOT invoked
 *   synchronously with the current value on registration (callers that need
 *   the current value should call `current()` first). Returns an unsubscribe
 *   handle.
 * @property {(targets: FanoutTargets) => void} setFanoutTargets
 *   Wire the OutboundQueue / SyncEngine fan-out. Both are optional — the
 *   service silently no-ops when the matching target is absent. The
 *   {@link OfflineProvider} (task 16.2) calls this once both subsystems are
 *   constructed.
 * @property {() => void} stop
 *   Tear down every subscription and clear the fan-out targets. Safe to call
 *   multiple times. After `stop()`, `current()` reverts to the optimistic
 *   default.
 */

/**
 * @typedef {Object} CreateConnectivityOptions
 * @property {NetworkPlugin} [network]
 *   `@capacitor/network` Network plugin. Defaults to the real plugin import.
 *   Tests inject a stub.
 * @property {{ log: (e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void }} [diagnostics]
 *   Defaults to {@link getDiagnostics}.
 * @property {() => boolean} [isNativePlatform]
 *   Defaults to `Capacitor.isNativePlatform()`. When this returns `false`,
 *   the network plugin is bypassed in favor of `navigator.onLine` + the
 *   `window` `online`/`offline` events.
 * @property {() => number} [now]
 *   Override `Date.now()` for deterministic tests (used for the 30s
 *   diagnostics window only).
 * @property {Window | null} [windowRef]
 *   Override the `window` reference. Defaults to `globalThis.window` when
 *   defined, else `null`. Tests inject an `EventTarget`-shaped stub when
 *   exercising the non-native fallback.
 * @property {{ onLine?: boolean } | null} [navigatorRef]
 *   Override the `navigator` reference. Defaults to `globalThis.navigator`
 *   when defined, else `null`. Used only when `isNativePlatform()` is false.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a connectivity state from the two boolean inputs per the §3.9 truth
 * table / Property 20. Pure function; exported (via `__internals`) so tests
 * can pin the mapping directly without spinning up a service instance.
 *
 * @param {boolean} networkConnected
 * @param {boolean} socketConnected
 * @returns {ConnectivityState}
 */
function deriveState(networkConnected, socketConnected) {
  if (!networkConnected) return "offline";
  if (socketConnected) return "online";
  return "reconnecting";
}

/**
 * Some Capacitor `addListener` calls return a `Promise<{ remove }>` (the
 * current contract); older builds return `{ remove }` synchronously. This
 * helper normalizes both into a plain `() => void` unsubscribe handle.
 *
 * @param {unknown} handle
 * @returns {() => void}
 */
function unwrapPluginListenerHandle(handle) {
  if (handle == null) return () => {};
  // Promise-shaped: resolve, then call `.remove()`.
  if (typeof (/** @type {{ then?: unknown }} */ (handle).then) === "function") {
    let removed = false;
    let pendingRemove = /** @type {(() => Promise<void> | void) | null} */ (null);
    /** @type {Promise<{ remove?: () => Promise<void> | void }>} */ (handle)
      .then((h) => {
        if (h && typeof h.remove === "function") {
          if (removed) {
            try {
              void h.remove();
            } catch {
              // swallow — best-effort cleanup
            }
          } else {
            pendingRemove = h.remove.bind(h);
          }
        }
      })
      .catch(() => {
        // Plugin listener registration failed; nothing to remove.
      });
    return () => {
      removed = true;
      if (pendingRemove != null) {
        try {
          void pendingRemove();
        } catch {
          // swallow
        }
        pendingRemove = null;
      }
    };
  }
  // Sync-shaped: `{ remove }` already.
  const obj = /** @type {{ remove?: () => Promise<void> | void }} */ (handle);
  if (typeof obj.remove === "function") {
    return () => {
      try {
        void obj.remove?.();
      } catch {
        // swallow
      }
    };
  }
  return () => {};
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh Connectivity instance. Tests should construct their own via
 * this factory; production code should prefer {@link getConnectivity}.
 *
 * @param {CreateConnectivityOptions} [options]
 * @returns {Connectivity}
 */
export function createConnectivity(options = {}) {
  const network = options.network != null ? options.network : Network;
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const isNativePlatform =
    typeof options.isNativePlatform === "function"
      ? options.isNativePlatform
      : () => Capacitor.isNativePlatform();
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const windowRef =
    options.windowRef !== undefined
      ? options.windowRef
      : typeof globalThis !== "undefined" && globalThis.window != null
        ? /** @type {Window} */ (globalThis.window)
        : null;
  const navigatorRef =
    options.navigatorRef !== undefined
      ? options.navigatorRef
      : typeof globalThis !== "undefined" && globalThis.navigator != null
        ? /** @type {{ onLine?: boolean }} */ (globalThis.navigator)
        : null;

  // ----- Mutable state ----------------------------------------------------

  /** @type {boolean} */
  let networkConnected = navigatorRef?.onLine !== false; // optimistic default
  /** @type {boolean} */
  let socketConnected = false;
  /** Last `connect`/`disconnect` event timestamp in ms (diagnostics only). */
  let lastSocketEventAtMs = 0;
  /** @type {ConnectivityState} */
  let derived = deriveState(networkConnected, socketConnected);
  /** @type {ConnectivitySocket | null} */
  let boundSocket = null;
  /** @type {Set<(state: ConnectivityState) => void>} */
  const listeners = new Set();
  /** @type {FanoutTargets} */
  let fanout = {};
  /** @type {Array<() => void>} */
  let teardown = [];
  let started = false;

  // ----- Internal helpers ------------------------------------------------

  /**
   * Recompute the derived state and, if it changed, notify listeners and
   * fan out to OutboundQueue / SyncEngine. Listener invocations are
   * try/catch-wrapped so a buggy subscriber cannot wedge the rest of the
   * notification chain.
   *
   * @param {string} reason
   */
  function recomputeAndEmit(reason) {
    const next = deriveState(networkConnected, socketConnected);
    if (next === derived) return;
    const previous = derived;
    derived = next;

    diagnostics.log({
      category: "live",
      code: "CONNECTIVITY_STATE_CHANGED",
      outcome: "ok",
      meta: {
        from: previous,
        to: next,
        networkConnected,
        socketConnected,
        reason,
        sinceLastSocketEventMs:
          lastSocketEventAtMs > 0 ? Math.max(0, now() - lastSocketEventAtMs) : -1,
      },
    });

    // Fan out to the queue / sync engine first — these are the operational
    // hooks (Req 11.5). External UI subscribers (Req 11.1 / 11.2 / 11.3)
    // run after so they observe the same ordering as the operational
    // side-effects.
    try {
      const trigger = fanout.outboundQueue?.triggerDrain;
      if (typeof trigger === "function") {
        trigger();
      } else if (typeof fanout.outboundQueue?.drain === "function") {
        // `drain` returns a promise; fire-and-forget.
        void fanout.outboundQueue.drain().catch(() => {
          // OutboundQueue logs its own diagnostics; nothing to do here.
        });
      }
    } catch (err) {
      diagnostics.log({
        category: "error",
        code: "CONNECTIVITY_FANOUT_OUTBOUND_FAILED",
        outcome: "warn",
        meta: { error: String(err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err) },
      });
    }
    try {
      const onChange = fanout.syncEngine?.onConnectivityChange;
      if (typeof onChange === "function") {
        onChange(next);
      }
    } catch (err) {
      diagnostics.log({
        category: "error",
        code: "CONNECTIVITY_FANOUT_SYNC_FAILED",
        outcome: "warn",
        meta: { error: String(err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err) },
      });
    }

    const snapshotListeners = Array.from(listeners);
    for (const listener of snapshotListeners) {
      try {
        listener(next);
      } catch (err) {
        diagnostics.log({
          category: "error",
          code: "CONNECTIVITY_LISTENER_FAILED",
          outcome: "warn",
          meta: { error: String(err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err) },
        });
      }
    }
  }

  // ----- Network source: Capacitor plugin (native) ----------------------

  /**
   * Hook the Capacitor `@capacitor/network` plugin. Reads the current status
   * once (so the derived state reflects radio reachability before the first
   * event lands), then subscribes to `networkStatusChange`.
   *
   * @returns {Promise<() => void>}
   */
  async function startNativeNetwork() {
    /** @type {() => void} */
    let unsubscribe = () => {};
    try {
      const initial = await network.getStatus();
      networkConnected = initial?.connected !== false;
      recomputeAndEmit("network_initial");
    } catch (err) {
      diagnostics.log({
        category: "error",
        code: "NETWORK_GET_STATUS_FAILED",
        outcome: "warn",
        meta: { error: String(err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err) },
      });
    }
    try {
      const handle = network.addListener("networkStatusChange", (status) => {
        networkConnected = status?.connected !== false;
        recomputeAndEmit("network_event");
      });
      unsubscribe = unwrapPluginListenerHandle(handle);
    } catch (err) {
      diagnostics.log({
        category: "error",
        code: "NETWORK_ADD_LISTENER_FAILED",
        outcome: "warn",
        meta: { error: String(err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err) },
      });
    }
    return unsubscribe;
  }

  // ----- Network source: navigator.onLine fallback (web / tests) --------

  /**
   * Hook the browser `online`/`offline` events. Used when the Capacitor
   * plugin is unavailable so vite dev / jsdom tests do not crash.
   *
   * @returns {() => void}
   */
  function startWebNetwork() {
    if (windowRef == null || typeof windowRef.addEventListener !== "function") {
      // No DOM at all (Node CI without jsdom). Treat as connected — the
      // socket portion of the truth table still produces sensible states.
      networkConnected = true;
      recomputeAndEmit("network_initial");
      return () => {};
    }
    const onOnline = () => {
      networkConnected = true;
      recomputeAndEmit("network_event");
    };
    const onOffline = () => {
      networkConnected = false;
      recomputeAndEmit("network_event");
    };
    networkConnected = navigatorRef?.onLine !== false;
    recomputeAndEmit("network_initial");
    windowRef.addEventListener("online", onOnline);
    windowRef.addEventListener("offline", onOffline);
    return () => {
      try {
        windowRef.removeEventListener("online", onOnline);
        windowRef.removeEventListener("offline", onOffline);
      } catch {
        // swallow — best-effort cleanup
      }
    };
  }

  // ----- Socket source ---------------------------------------------------

  /**
   * Subscribe to `connect` / `disconnect` on the supplied socket. The 30s
   * window is tracked via `lastSocketEventAtMs` for diagnostics only (the
   * derived state is a pure function of `networkConnected` / `socketConnected`,
   * see Property 20).
   *
   * @param {ConnectivitySocket} socket
   * @returns {() => void}
   */
  function startSocket(socket) {
    const onConnect = () => {
      socketConnected = true;
      lastSocketEventAtMs = now();
      recomputeAndEmit("socket_connect");
    };
    const onDisconnect = () => {
      socketConnected = false;
      lastSocketEventAtMs = now();
      recomputeAndEmit("socket_disconnect");
    };

    // Seed with the current `socket.connected` flag. socket.io's `Socket`
    // exposes this synchronously; if it's missing the optimistic default
    // (`false`) is fine — the next `connect` event will correct it.
    socketConnected = socket.connected === true;
    if (socketConnected) {
      lastSocketEventAtMs = now();
    }
    recomputeAndEmit("socket_initial");

    try {
      socket.on("connect", onConnect);
      socket.on("disconnect", onDisconnect);
    } catch (err) {
      diagnostics.log({
        category: "error",
        code: "SOCKET_ADD_LISTENER_FAILED",
        outcome: "warn",
        meta: { error: String(err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err) },
      });
    }

    return () => {
      try {
        socket.off("connect", onConnect);
        socket.off("disconnect", onDisconnect);
      } catch {
        // swallow — best-effort cleanup
      }
    };
  }

  // ----- Public API ------------------------------------------------------

  /**
   * @param {ConnectivitySocket} socket
   * @returns {() => void}
   */
  function start(socket) {
    if (socket == null) {
      throw new Error("Connectivity.start: socket is required");
    }
    if (started && boundSocket === socket) {
      // Idempotent re-start with the same socket — return the existing stop.
      return stop;
    }
    if (started) {
      // Re-start with a different socket: tear down the previous subs first.
      stop();
    }
    started = true;
    boundSocket = socket;

    if (isNativePlatform()) {
      // Native path: subscribe to the Capacitor plugin asynchronously. We
      // push a deferred unsubscribe so `stop()` always works even if the
      // plugin has not finished resolving yet.
      let nativeUnsub = /** @type {() => void} */ (() => {});
      let cancelled = false;
      const teardownEntry = () => {
        cancelled = true;
        try {
          nativeUnsub();
        } catch {
          // swallow
        }
      };
      teardown.push(teardownEntry);
      void startNativeNetwork().then((unsub) => {
        if (cancelled) {
          try {
            unsub();
          } catch {
            // swallow
          }
          return;
        }
        nativeUnsub = unsub;
      });
    } else {
      // Web / jsdom / Node fallback.
      teardown.push(startWebNetwork());
    }

    teardown.push(startSocket(socket));

    diagnostics.log({
      category: "live",
      code: "CONNECTIVITY_STARTED",
      outcome: "ok",
      meta: {
        nativePlatform: isNativePlatform(),
        initialState: derived,
      },
    });

    return stop;
  }

  /**
   * @returns {ConnectivityState}
   */
  function current() {
    return derived;
  }

  /**
   * @param {(state: ConnectivityState) => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new Error("Connectivity.subscribe: listener must be a function");
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * @param {FanoutTargets} targets
   */
  function setFanoutTargets(targets) {
    fanout = targets != null && typeof targets === "object" ? { ...targets } : {};
  }

  function stop() {
    if (!started) return;
    started = false;
    const previous = teardown;
    teardown = [];
    for (const fn of previous) {
      try {
        fn();
      } catch {
        // swallow — best-effort cleanup
      }
    }
    boundSocket = null;
    // Reset to optimistic defaults so a subsequent `start()` does not emit
    // a stale state from the previous session.
    socketConnected = false;
    lastSocketEventAtMs = 0;
    networkConnected = navigatorRef?.onLine !== false;
    derived = deriveState(networkConnected, socketConnected);

    diagnostics.log({
      category: "live",
      code: "CONNECTIVITY_STOPPED",
      outcome: "ok",
    });
  }

  return {
    start,
    current,
    subscribe,
    setFanoutTargets,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** @type {Connectivity | null} */
let singleton = null;

/**
 * Process-wide Connectivity used by the `OfflineProvider` and consumed by
 * the OutboundQueue / SyncEngine via `setFanoutTargets`. Tests must use
 * {@link createConnectivity} directly with their own stubs.
 *
 * @returns {Connectivity}
 */
export function getConnectivity() {
  if (singleton == null) {
    singleton = createConnectivity();
  }
  return singleton;
}

/**
 * Reset the singleton. Exported strictly for test setup.
 *
 * @internal
 */
export function __resetConnectivitySingletonForTests() {
  if (singleton != null) {
    try {
      singleton.stop();
    } catch {
      // swallow
    }
  }
  singleton = null;
}

// Internal helpers exposed for the connectivity property test (Property 20).
// Not part of the public surface used by the rest of the offline module.
export const __internals = Object.freeze({
  deriveState,
  SOCKET_EVENT_WINDOW_MS,
});
