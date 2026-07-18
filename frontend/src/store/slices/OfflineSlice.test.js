import { describe, it, expect, beforeEach } from "vitest";
import {
  createOfflineSlice,
  OFFLINE_SLICE_DEFAULTS,
} from "./OfflineSlice.js";
import { useAppStore } from "../index.js";

/**
 * Tiny harness that mirrors zustand's `set` semantics (object or updater
 * function) without pulling in the store. Lets us exercise the slice in
 * isolation and assert exactly what each setter writes.
 */
function makeHarness() {
  let state = {};
  const set = (partial) => {
    const next =
      typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const slice = createOfflineSlice(set, () => state);
  // The slice creator returned the initial state + setters; seed `state` with
  // it so updater-style sets see the defaults.
  state = { ...slice };
  return {
    get: () => state,
    slice,
  };
}

describe("OfflineSlice — defaults", () => {
  it("seeds the documented default values", () => {
    const { slice } = makeHarness();
    expect(slice.connectivity).toBe("online");
    expect(slice.bootstrapStatus).toBe("idle");
    expect(slice.outboundQueueLength).toBe(0);
    expect(slice.offlineMode).toBe("available");
    expect(slice.localEncryption).toBe("secure");
    expect(slice.lastIncrementalSyncAt).toBeNull();
    expect(slice.isInitialized).toBe(false);
  });

  it("OFFLINE_SLICE_DEFAULTS is frozen and exported", () => {
    expect(Object.isFrozen(OFFLINE_SLICE_DEFAULTS)).toBe(true);
  });
});

describe("OfflineSlice — setConnectivity", () => {
  it("accepts each member of the union", () => {
    for (const v of ["online", "offline", "reconnecting"]) {
      const h = makeHarness();
      h.slice.setConnectivity(v);
      expect(h.get().connectivity).toBe(v);
    }
  });

  it("ignores unknown values and preserves the previous state", () => {
    const h = makeHarness();
    h.slice.setConnectivity("offline");
    h.slice.setConnectivity("flying");
    h.slice.setConnectivity(null);
    h.slice.setConnectivity(42);
    expect(h.get().connectivity).toBe("offline");
  });
});

describe("OfflineSlice — setBootstrapStatus", () => {
  it("accepts each member of the union", () => {
    for (const v of ["idle", "running", "ready", "partial"]) {
      const h = makeHarness();
      h.slice.setBootstrapStatus(v);
      expect(h.get().bootstrapStatus).toBe(v);
    }
  });

  it("ignores unknown values", () => {
    const h = makeHarness();
    h.slice.setBootstrapStatus("running");
    h.slice.setBootstrapStatus("done");
    expect(h.get().bootstrapStatus).toBe("running");
  });
});

describe("OfflineSlice — setOutboundQueueLength", () => {
  it("stores a non-negative integer", () => {
    const h = makeHarness();
    h.slice.setOutboundQueueLength(7);
    expect(h.get().outboundQueueLength).toBe(7);
  });

  it("clamps negatives to zero", () => {
    const h = makeHarness();
    h.slice.setOutboundQueueLength(-3);
    expect(h.get().outboundQueueLength).toBe(0);
  });

  it("floors fractional values", () => {
    const h = makeHarness();
    h.slice.setOutboundQueueLength(4.9);
    expect(h.get().outboundQueueLength).toBe(4);
  });

  it("ignores NaN, Infinity, and non-numeric inputs", () => {
    const h = makeHarness();
    h.slice.setOutboundQueueLength(5);
    h.slice.setOutboundQueueLength(NaN);
    h.slice.setOutboundQueueLength(Infinity);
    h.slice.setOutboundQueueLength("12");
    h.slice.setOutboundQueueLength(null);
    expect(h.get().outboundQueueLength).toBe(5);
  });
});

describe("OfflineSlice — setOfflineMode", () => {
  it("accepts the union", () => {
    const h = makeHarness();
    h.slice.setOfflineMode("unavailable");
    expect(h.get().offlineMode).toBe("unavailable");
    h.slice.setOfflineMode("available");
    expect(h.get().offlineMode).toBe("available");
  });

  it("ignores out-of-domain values", () => {
    const h = makeHarness();
    h.slice.setOfflineMode("unavailable");
    h.slice.setOfflineMode("partial");
    expect(h.get().offlineMode).toBe("unavailable");
  });
});

describe("OfflineSlice — setLocalEncryption", () => {
  it("accepts secure/none", () => {
    const h = makeHarness();
    h.slice.setLocalEncryption("none");
    expect(h.get().localEncryption).toBe("none");
    h.slice.setLocalEncryption("secure");
    expect(h.get().localEncryption).toBe("secure");
  });

  it("ignores invalid values", () => {
    const h = makeHarness();
    h.slice.setLocalEncryption("none");
    h.slice.setLocalEncryption("aes-256");
    expect(h.get().localEncryption).toBe("none");
  });
});

describe("OfflineSlice — setLastIncrementalSyncAt", () => {
  it("accepts an ISO-8601 string", () => {
    const h = makeHarness();
    const iso = "2025-01-02T03:04:05.000Z";
    h.slice.setLastIncrementalSyncAt(iso);
    expect(h.get().lastIncrementalSyncAt).toBe(iso);
  });

  it("accepts null to clear", () => {
    const h = makeHarness();
    h.slice.setLastIncrementalSyncAt("2025-01-02T03:04:05.000Z");
    h.slice.setLastIncrementalSyncAt(null);
    expect(h.get().lastIncrementalSyncAt).toBeNull();
  });

  it("ignores empty strings and non-strings", () => {
    const h = makeHarness();
    h.slice.setLastIncrementalSyncAt("2025-01-02T03:04:05.000Z");
    h.slice.setLastIncrementalSyncAt("");
    h.slice.setLastIncrementalSyncAt(123);
    expect(h.get().lastIncrementalSyncAt).toBe("2025-01-02T03:04:05.000Z");
  });
});

describe("OfflineSlice — setIsInitialized", () => {
  it("accepts boolean values", () => {
    const h = makeHarness();
    h.slice.setIsInitialized(true);
    expect(h.get().isInitialized).toBe(true);
    h.slice.setIsInitialized(false);
    expect(h.get().isInitialized).toBe(false);
  });

  it("ignores non-boolean values", () => {
    const h = makeHarness();
    h.slice.setIsInitialized(true);
    h.slice.setIsInitialized("false");
    h.slice.setIsInitialized(null);
    h.slice.setIsInitialized(1);
    expect(h.get().isInitialized).toBe(true);
  });
});

describe("OfflineSlice — applyDiagnosticsSnapshot (Req 14.2)", () => {
  it("copies the overlapping fields from a Diagnostics.snapshot() payload", () => {
    const h = makeHarness();
    h.slice.applyDiagnosticsSnapshot({
      events: [],
      schemaVersion: 1,
      mediaCacheSize: 12345,
      outboundQueueLength: 4,
      localEncryption: "none",
    });
    expect(h.get().outboundQueueLength).toBe(4);
    expect(h.get().localEncryption).toBe("none");
    // No corresponding slice field, must not bleed onto state.
    expect(h.get().mediaCacheSize).toBeUndefined();
    expect(h.get().schemaVersion).toBeUndefined();
  });

  it("skips fields the snapshot doesn't carry", () => {
    const h = makeHarness();
    h.slice.setOutboundQueueLength(2);
    h.slice.applyDiagnosticsSnapshot({ localEncryption: "none" });
    expect(h.get().outboundQueueLength).toBe(2); // untouched
    expect(h.get().localEncryption).toBe("none");
  });

  it("ignores invalid snapshot values without overwriting current state", () => {
    const h = makeHarness();
    h.slice.setOutboundQueueLength(3);
    h.slice.setLocalEncryption("secure");
    h.slice.applyDiagnosticsSnapshot({
      outboundQueueLength: "not a number",
      localEncryption: "rot13",
    });
    expect(h.get().outboundQueueLength).toBe(3);
    expect(h.get().localEncryption).toBe("secure");
  });

  it("no-ops on null / non-object inputs", () => {
    const h = makeHarness();
    expect(() => h.slice.applyDiagnosticsSnapshot(null)).not.toThrow();
    expect(() => h.slice.applyDiagnosticsSnapshot(undefined)).not.toThrow();
    expect(() => h.slice.applyDiagnosticsSnapshot("nope")).not.toThrow();
    expect(h.get().outboundQueueLength).toBe(0);
  });
});

describe("OfflineSlice — resetOfflineSlice", () => {
  it("restores every field to its default", () => {
    const h = makeHarness();
    h.slice.setConnectivity("offline");
    h.slice.setBootstrapStatus("partial");
    h.slice.setOutboundQueueLength(11);
    h.slice.setOfflineMode("unavailable");
    h.slice.setLocalEncryption("none");
    h.slice.setLastIncrementalSyncAt("2025-01-02T03:04:05.000Z");

    h.slice.resetOfflineSlice();

    const s = h.get();
    expect(s.connectivity).toBe(OFFLINE_SLICE_DEFAULTS.connectivity);
    expect(s.bootstrapStatus).toBe(OFFLINE_SLICE_DEFAULTS.bootstrapStatus);
    expect(s.outboundQueueLength).toBe(OFFLINE_SLICE_DEFAULTS.outboundQueueLength);
    expect(s.offlineMode).toBe(OFFLINE_SLICE_DEFAULTS.offlineMode);
    expect(s.localEncryption).toBe(OFFLINE_SLICE_DEFAULTS.localEncryption);
    expect(s.lastIncrementalSyncAt).toBe(OFFLINE_SLICE_DEFAULTS.lastIncrementalSyncAt);
    expect(s.isInitialized).toBe(OFFLINE_SLICE_DEFAULTS.isInitialized);
  });
});

describe("OfflineSlice — wired into useAppStore", () => {
  beforeEach(() => {
    useAppStore.getState().resetOfflineSlice();
  });

  it("exposes the slice fields and setters as top-level keys on the combined store", () => {
    const s = useAppStore.getState();
    expect(s.connectivity).toBe("online");
    expect(s.bootstrapStatus).toBe("idle");
    expect(s.outboundQueueLength).toBe(0);
    expect(s.offlineMode).toBe("available");
    expect(s.localEncryption).toBe("secure");
    expect(s.lastIncrementalSyncAt).toBeNull();
    expect(s.isInitialized).toBe(false);
    expect(typeof s.setConnectivity).toBe("function");
    expect(typeof s.setIsInitialized).toBe("function");
    expect(typeof s.applyDiagnosticsSnapshot).toBe("function");
    expect(typeof s.resetOfflineSlice).toBe("function");
  });

  it("setters update the combined store", () => {
    useAppStore.getState().setConnectivity("offline");
    useAppStore.getState().setBootstrapStatus("running");
    useAppStore.getState().setOutboundQueueLength(2);

    const after = useAppStore.getState();
    expect(after.connectivity).toBe("offline");
    expect(after.bootstrapStatus).toBe("running");
    expect(after.outboundQueueLength).toBe(2);

    // Sanity: it didn't clobber other slices.
    expect(after.user).toBeNull();
    expect(after.selectedChatMessages).toEqual([]);
  });
});
