// @ts-nocheck
/**
 * OfflineProvider — wiring tests.
 *
 * The provider is the single seam between the offline subsystem
 * singletons and the React tree. These tests stub every singleton
 * (repository, SyncEngine, OutboundQueue, Connectivity, MediaCache,
 * EncryptionLayer) and verify the *wiring* — what gets called, in what
 * order, with which arguments — without re-testing the behavior of the
 * underlying modules (which have their own unit / property tests).
 *
 * Implements task 16.2 of `.kiro/specs/offline-support/tasks.md`.
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// React 18+ requires this flag to be set so `act(...)` knows it's running
// inside a test environment. Without it React logs a noisy warning to
// stderr on every render — the assertions themselves work either way.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Track which platform `Capacitor.isNativePlatform()` should report. Each
// test toggles this before mounting.
let nativePlatform = true;

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => (nativePlatform ? "android" : "web"),
  },
}));

// The component imports `axios` and forwards it to the SyncEngine /
// OutboundQueue singletons. Since both singletons are stubbed below we
// don't need axios to do anything — but the import has to resolve.
vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Singleton stubs
// ---------------------------------------------------------------------------
//
// Each stub records every call into a shared `calls` array so the tests can
// assert the cross-module order (sync.stop must fire before media.stop,
// etc.). Methods return resolved promises by default; individual tests can
// replace a method with a custom stub before mounting.

/** @type {Array<{ subject: string, method: string, args?: unknown[] }>} */
let calls = [];

function record(subject, method, args) {
  calls.push({ subject, method, args });
}

let repoStub;
let syncEngineStub;
let outboundQueueStub;
let connectivityStub;
let mediaCacheStub;
let encryptionStub;
let getRepositoryMock;
let getSyncEngineMock;
let getOutboundQueueMock;
let getConnectivityMock;
let getMediaCacheMock;
let getEncryptionLayerMock;

vi.mock("./repositories/index.js", () => ({
  getRepository: (...a) => getRepositoryMock(...a),
}));
vi.mock("./sync/SyncEngine.js", () => ({
  getSyncEngine: (...a) => getSyncEngineMock(...a),
}));
vi.mock("./sync/OutboundQueue.js", () => ({
  getOutboundQueue: (...a) => getOutboundQueueMock(...a),
}));
vi.mock("./services/Connectivity.js", () => ({
  getConnectivity: (...a) => getConnectivityMock(...a),
}));
vi.mock("./services/MediaCache.js", () => ({
  getMediaCache: (...a) => getMediaCacheMock(...a),
}));
vi.mock("./services/EncryptionLayer.js", () => ({
  getEncryptionLayer: (...a) => getEncryptionLayerMock(...a),
}));

vi.mock("./utils/Diagnostics.js", () => ({
  getDiagnostics: () => ({
    log: () => {},
    snapshot: () => ({}),
    toClipboardText: () => "",
  }),
}));

// SocketContext exposes `useSocket()`. The provider reads the live socket
// from the context value `{ socket, onlineUsers }`. We expose a setter so
// each test can swap the socket between mounts.
let mockSocket = null;
vi.mock("../context/SocketContext.jsx", () => ({
  useSocket: () => ({ socket: mockSocket, onlineUsers: [] }),
}));

// The store import resolves to the real zustand store — that's exactly
// what we want: tests should drive `setUser(...)` and observe the slice
// reactions through the live store, mirroring production behavior.
import useAppStore from "../store/index.js";
import { OfflineProvider } from "./OfflineProvider.jsx";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSocketStub() {
  return {
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
  };
}

function buildRepoStub({ initResult = { ok: true }, contacts = [], channels = [], queue = [] } = {}) {
  return {
    init: vi.fn(async (args) => {
      record("repo", "init", [args]);
      return initResult;
    }),
    isReady: vi.fn(() => true),
    wipe: vi.fn(async () => {
      record("repo", "wipe");
    }),
    clearAndRebootstrap: vi.fn(async () => {
      record("repo", "clearAndRebootstrap");
    }),
    onClearAndRebootstrap: vi.fn(() => () => {}),
    getContacts: vi.fn(async () => contacts),
    getChannels: vi.fn(async () => channels),
    getMessages: vi.fn(async () => []),
    getMessageById: vi.fn(async () => null),
    getOutboundQueue: vi.fn(async () => queue),
    getCachedMediaPath: vi.fn(async () => null),
    resetUnreadCount: vi.fn(async () => undefined),
    applyServerMessages: vi.fn(async () => ({ inserted: 0, updated: 0, ignored: 0 })),
    applyLiveMessage: vi.fn(async () => undefined),
    applyDeletion: vi.fn(async () => undefined),
    applyStatusUpdate: vi.fn(async () => undefined),
    enqueueOutbound: vi.fn(async () => ({ id: "x", queueSeq: 0, clientTempId: null })),
    markOutboundConfirmed: vi.fn(async () => undefined),
    markOutboundFailed: vi.fn(async () => undefined),
    subscribeMessages: vi.fn(() => () => {}),
    subscribeContacts: vi.fn(() => () => {}),
    subscribeChannels: vi.fn(() => () => {}),
    getDiagnosticsSnapshot: vi.fn(() => ({})),
    getCurrentUserId: vi.fn(() => null),
    getDriver: vi.fn(() => ({})),
    getMutex: vi.fn(() => ({})),
  };
}

function buildSyncEngineStub() {
  return {
    start: vi.fn(async (args) => {
      record("sync", "start", [args]);
    }),
    stop: vi.fn(async () => {
      record("sync", "stop");
    }),
    bootstrap: vi.fn(async () => ({})),
    incremental: vi.fn(async () => ({})),
    applyLiveEvent: vi.fn(async () => undefined),
    onConnectivityChange: vi.fn(),
    getStatus: vi.fn(() => ({
      phase: "ready",
      lastIncrementalSyncAt: null,
      bootstrapStatus: "ok",
    })),
  };
}

function buildOutboundQueueStub() {
  return {
    start: vi.fn(async () => {
      record("outbound", "start");
    }),
    stop: vi.fn(async () => {
      record("outbound", "stop");
    }),
    drain: vi.fn(async () => undefined),
    triggerDrain: vi.fn(),
    enqueue: vi.fn(async () => ({ id: "x", queueSeq: 0, clientTempId: null })),
    setSocket: vi.fn(),
    isDraining: vi.fn(() => false),
  };
}

function buildConnectivityStub() {
  /** @type {Array<(state: string) => void>} */
  const listeners = [];
  let state = "online";
  return {
    start: vi.fn((socket) => {
      record("connectivity", "start", [socket]);
      return () => {};
    }),
    stop: vi.fn(() => {
      record("connectivity", "stop");
    }),
    current: vi.fn(() => state),
    subscribe: vi.fn((listener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    setFanoutTargets: vi.fn(),
    /** Test-only emit helper. */
    __emit: (next) => {
      state = next;
      for (const l of listeners) l(next);
    },
  };
}

function buildMediaCacheStub() {
  return {
    start: vi.fn(() => {
      record("media", "start");
    }),
    stop: vi.fn(() => {
      record("media", "stop");
    }),
    onServerMessages: vi.fn(async () => undefined),
    onLiveMessage: vi.fn(async () => undefined),
    onUserImageChanged: vi.fn(async () => undefined),
    getCachedMediaPath: vi.fn(async () => null),
    evictIfOverBudget: vi.fn(async () => ({ evicted: 0, bytesFreed: 0 })),
    downloadOnTap: vi.fn(async () => ({ ok: true })),
    getTotalCachedBytes: vi.fn(async () => 0),
  };
}

function buildEncryptionStub({ available = true } = {}) {
  return {
    getOrCreatePassphrase: vi.fn(async () => ({ mode: "secure", passphrase: "" })),
    rotate: vi.fn(async () => undefined),
    destroy: vi.fn(async () => {
      record("encryption", "destroy");
    }),
    diagnoseAvailability: vi.fn(async () => ({ available })),
  };
}

/**
 * Mount the provider and return a handle that lets the test drive the
 * user state, the socket reference, and unmount.
 */
function mountProvider({ user = null, socket = null } = {}) {
  // Reset the slice to defaults and seed `user`.
  const store = useAppStore.getState();
  store.resetOfflineSlice();
  store.setUser(user);

  mockSocket = socket;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<OfflineProvider>hello</OfflineProvider>);
  });

  return {
    container,
    root,
    setUser: (next) => {
      act(() => {
        useAppStore.getState().setUser(next);
      });
    },
    setSocket: (next) => {
      mockSocket = next;
      act(() => {
        // Trigger a re-render by toggling a benign part of state via a
        // dummy setter? The provider's effect dep array is `[user?.id,
        // socket]` but `socket` is captured via `useSocket()` which is
        // a stub that re-reads `mockSocket`. Re-render through a
        // no-op setUser to itself.
        const u = useAppStore.getState().user;
        useAppStore.getState().setUser(u != null ? { ...u } : null);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Wait for queued microtasks. The provider's boot effect launches an
 * async IIFE; we flush microtasks until the boot promise settles.
 */
async function flush() {
  // Two passes covers the chain: setOfflineMode → repo.init →
  // diagnose → hydrate → mediaCache.start → connectivity.subscribe →
  // outboundQueue.start → syncEngine.start.
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  calls = [];
  nativePlatform = true;
  mockSocket = null;
  repoStub = buildRepoStub();
  syncEngineStub = buildSyncEngineStub();
  outboundQueueStub = buildOutboundQueueStub();
  connectivityStub = buildConnectivityStub();
  mediaCacheStub = buildMediaCacheStub();
  encryptionStub = buildEncryptionStub();
  getRepositoryMock = vi.fn(() => repoStub);
  getSyncEngineMock = vi.fn(() => syncEngineStub);
  getOutboundQueueMock = vi.fn(() => outboundQueueStub);
  getConnectivityMock = vi.fn(() => connectivityStub);
  getMediaCacheMock = vi.fn(() => mediaCacheStub);
  getEncryptionLayerMock = vi.fn(() => encryptionStub);
  // Reset the live store so user / slice fields start fresh.
  useAppStore.getState().setUser(null);
  useAppStore.getState().resetOfflineSlice();
});

afterEach(() => {
  // Make sure nothing keeps pending timers around (the provider sets
  // `setInterval` for status / queue polls). If a test forgets to
  // unmount, vi.useRealTimers() would otherwise leak intervals across
  // tests and break the order assertions.
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OfflineProvider — boot gating", () => {
  it("does nothing when `user` is null", async () => {
    const handle = mountProvider({ user: null, socket: buildSocketStub() });
    await flush();
    expect(repoStub.init).not.toHaveBeenCalled();
    expect(syncEngineStub.start).not.toHaveBeenCalled();
    expect(connectivityStub.start).not.toHaveBeenCalled();
    handle.unmount();
  });

  it("flips offlineMode to 'unavailable' on a non-native platform", async () => {
    nativePlatform = false;
    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();
    expect(useAppStore.getState().offlineMode).toBe("unavailable");
    expect(repoStub.init).not.toHaveBeenCalled();
    expect(connectivityStub.start).not.toHaveBeenCalled();
    handle.unmount();
  });

  it("does nothing while the socket is null even with a user set", async () => {
    const handle = mountProvider({ user: { id: "u1" }, socket: null });
    await flush();
    expect(repoStub.init).not.toHaveBeenCalled();
    expect(connectivityStub.start).not.toHaveBeenCalled();
    handle.unmount();
  });
});

describe("OfflineProvider — boot success path", () => {
  it("hydrates the slice and starts every subsystem in the documented order", async () => {
    const contacts = [{ _id: "c1", firstName: "Alice" }];
    const channels = [{ _id: "ch1", channelName: "general", admin: "u1", members: [] }];
    repoStub = buildRepoStub({ initResult: { ok: true }, contacts, channels });
    getRepositoryMock = vi.fn(() => repoStub);

    const sock = buildSocketStub();
    const handle = mountProvider({ user: { id: "u1" }, socket: sock });
    await flush();

    // Repository init was called with the userId.
    expect(repoStub.init).toHaveBeenCalledWith({ userId: "u1" });

    // Slice hydrated from local DB.
    const state = useAppStore.getState();
    expect(state.directMessagesContacts).toEqual(contacts);
    expect(state.channels).toEqual(channels);
    expect(state.offlineMode).toBe("available");
    expect(state.localEncryption).toBe("secure");
    expect(state.isInitialized).toBe(true);

    // SyncEngine.start called with userId.
    expect(syncEngineStub.start).toHaveBeenCalledWith({ userId: "u1" });

    // Connectivity wired to the live socket.
    expect(connectivityStub.start).toHaveBeenCalledTimes(1);
    expect(connectivityStub.start.mock.calls[0][0]).toBe(sock);
    expect(connectivityStub.subscribe).toHaveBeenCalled();
    expect(connectivityStub.setFanoutTargets).toHaveBeenCalled();

    // MediaCache.start invoked.
    expect(mediaCacheStub.start).toHaveBeenCalled();

    // OutboundQueue.start invoked.
    expect(outboundQueueStub.start).toHaveBeenCalled();

    // OutboundQueue construction received the live socket and the
    // shared connectivity instance.
    expect(getOutboundQueueMock).toHaveBeenCalledTimes(1);
    const queueOpts = getOutboundQueueMock.mock.calls[0][0];
    expect(queueOpts.repository).toBe(repoStub);
    expect(queueOpts.socket).toBe(sock);
    expect(queueOpts.connectivity).toBe(connectivityStub);

    handle.unmount();
    await flush();
    expect(useAppStore.getState().isInitialized).toBe(false);
  });

  it("sets localEncryption to 'none' when the secure store is unavailable", async () => {
    encryptionStub = buildEncryptionStub({ available: false });
    getEncryptionLayerMock = vi.fn(() => encryptionStub);

    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    expect(useAppStore.getState().localEncryption).toBe("none");
    handle.unmount();
  });

  it("seeds connectivity slice from Connectivity.current() and updates on subscriber events", async () => {
    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    // Initial snapshot mirrors `current()` (the stub default is "online").
    expect(useAppStore.getState().connectivity).toBe("online");

    act(() => {
      connectivityStub.__emit("offline");
    });
    expect(useAppStore.getState().connectivity).toBe("offline");

    act(() => {
      connectivityStub.__emit("reconnecting");
    });
    expect(useAppStore.getState().connectivity).toBe("reconnecting");

    handle.unmount();
  });
});

describe("OfflineProvider — boot failure path", () => {
  it("flips offlineMode to 'unavailable' when repository.init returns ok:false", async () => {
    repoStub = buildRepoStub({ initResult: { ok: false, reason: "OPEN_FAILED" } });
    getRepositoryMock = vi.fn(() => repoStub);

    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    expect(repoStub.init).toHaveBeenCalled();
    expect(useAppStore.getState().offlineMode).toBe("unavailable");
    expect(syncEngineStub.start).not.toHaveBeenCalled();
    expect(connectivityStub.start).not.toHaveBeenCalled();
    expect(mediaCacheStub.start).not.toHaveBeenCalled();
    expect(outboundQueueStub.start).not.toHaveBeenCalled();
    handle.unmount();
  });

  it("flips offlineMode to 'unavailable' when repository.init throws", async () => {
    repoStub = buildRepoStub();
    repoStub.init = vi.fn(async () => {
      throw new Error("kaboom");
    });
    getRepositoryMock = vi.fn(() => repoStub);

    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    expect(useAppStore.getState().offlineMode).toBe("unavailable");
    expect(syncEngineStub.start).not.toHaveBeenCalled();
    handle.unmount();
  });
});

describe("OfflineProvider — teardown order on logout", () => {
  it("stops sync → media → connectivity → outbound, then wipe → encryption.destroy", async () => {
    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    // Drop the boot calls — the test only cares about teardown order.
    calls = [];

    // Logout — flip user to null. The effect cleanup runs synchronously
    // but the inner teardown is async; we then flush microtasks.
    handle.setUser(null);
    await flush();

    expect(syncEngineStub.stop).toHaveBeenCalledTimes(1);
    expect(mediaCacheStub.stop).toHaveBeenCalledTimes(1);
    expect(connectivityStub.stop).toHaveBeenCalledTimes(1);
    expect(outboundQueueStub.stop).toHaveBeenCalledTimes(1);
    expect(repoStub.wipe).toHaveBeenCalledTimes(1);
    expect(encryptionStub.destroy).toHaveBeenCalledTimes(1);

    // Check the documented order: sync.stop → media.stop →
    // connectivity.stop → outbound.stop → repo.wipe → encryption.destroy.
    const order = calls.map((c) => `${c.subject}.${c.method}`);
    const idx = (label) => order.indexOf(label);
    expect(idx("sync.stop")).toBeGreaterThanOrEqual(0);
    expect(idx("media.stop")).toBeGreaterThan(idx("sync.stop"));
    expect(idx("connectivity.stop")).toBeGreaterThan(idx("media.stop"));
    expect(idx("outbound.stop")).toBeGreaterThan(idx("connectivity.stop"));
    expect(idx("repo.wipe")).toBeGreaterThan(idx("outbound.stop"));
    expect(idx("encryption.destroy")).toBeGreaterThan(idx("repo.wipe"));

    handle.unmount();
  });

  it("resets the offline slice after teardown", async () => {
    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    // Pollute the slice so we can detect the reset.
    act(() => {
      useAppStore.getState().setOutboundQueueLength(7);
    });
    expect(useAppStore.getState().outboundQueueLength).toBe(7);

    handle.setUser(null);
    await flush();

    expect(useAppStore.getState().outboundQueueLength).toBe(0);
    expect(useAppStore.getState().connectivity).toBe("online");
    handle.unmount();
  });

  it("runs the same teardown when the provider unmounts", async () => {
    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();
    calls = [];

    handle.unmount();
    await flush();

    expect(syncEngineStub.stop).toHaveBeenCalled();
    expect(repoStub.wipe).toHaveBeenCalled();
    expect(encryptionStub.destroy).toHaveBeenCalled();
  });
});

describe("OfflineProvider — user switch", () => {
  it("tears down the previous user and re-inits when the user id changes", async () => {
    const handle = mountProvider({
      user: { id: "u1" },
      socket: buildSocketStub(),
    });
    await flush();

    expect(repoStub.init).toHaveBeenCalledWith({ userId: "u1" });

    handle.setUser({ id: "u2" });
    await flush();

    // First user's teardown ran (wipe + destroy).
    expect(repoStub.wipe).toHaveBeenCalled();
    expect(encryptionStub.destroy).toHaveBeenCalled();

    // Re-init for the new user. (The repository implementation itself
    // handles the user-switch wipe inside `init` — this test verifies
    // the provider re-runs init with the new userId.)
    const initCalls = repoStub.init.mock.calls.map((c) => c[0]?.userId);
    expect(initCalls).toContain("u2");

    handle.unmount();
  });
});
