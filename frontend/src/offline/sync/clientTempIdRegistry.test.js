// @ts-check
/**
 * Unit tests for the per-`clientTempId` deferred map (task 10.2).
 *
 * The registry is the single point of correlation between an outbound
 * socket emit (`sendMessage` / `send-channel-message`) and the
 * `receiveMessage` / `messageSendFailed` ack the SyncEngine forwards via
 * {@link createClientTempIdRegistry.resolve} / `.reject` (Req 6.4 / 6.5).
 *
 * The API surface is small but the failure modes are subtle:
 *
 *   - resolve / reject must clear the pending timer so a late timeout
 *     does not double-settle the deferred,
 *   - re-registering the same id (the user-retry path, Req 6.6) must
 *     reject the previous owner with `REPLACED` so the OutboundQueue's
 *     prior `register()` promise unwinds cleanly,
 *   - the default 30s timeout from §3.4 must be honored when the caller
 *     omits `timeoutMs`,
 *   - `has` / `_size` must reflect the live pending set so the
 *     OutboundQueue can audit registry leaks between drain passes.
 *
 * Tests inject a fake scheduler so timer-clearing semantics are
 * verifiable without real wall-clock waits.
 */

import { describe, it, expect } from "vitest";

import {
  createClientTempIdRegistry,
  getClientTempIdRegistry,
  __resetClientTempIdRegistryForTests,
  DEFAULT_TIMEOUT_MS,
} from "./clientTempIdRegistry.js";

/**
 * Build an in-memory `setTimeout` / `clearTimeout` pair backed by a
 * controllable handle map. Returns the scheduler plus a `fire` helper
 * that synchronously invokes the callback for a given handle (modeling
 * "the timer elapsed").
 */
function makeFakeScheduler() {
  let nextId = 1;
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const timers = new Map();

  /** @type {(fn: () => void, ms: number) => number} */
  const setTimeoutFn = (fn, ms) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { fn, ms });
    return id;
  };

  /** @type {(handle: unknown) => void} */
  const clearTimeoutFn = (handle) => {
    if (typeof handle === "number") timers.delete(handle);
  };

  return {
    setTimeoutFn,
    clearTimeoutFn,
    /** Number of armed (not-yet-fired, not-yet-cleared) timers. */
    pending: () => timers.size,
    /** Inspect the ms requested for a given handle. */
    msFor: (id) => {
      const t = timers.get(id);
      return t == null ? null : t.ms;
    },
    /** All currently-armed handles. */
    ids: () => Array.from(timers.keys()),
    /** Synchronously fire the most recently scheduled timer. */
    fireLatest: () => {
      const ids = Array.from(timers.keys());
      if (ids.length === 0) {
        throw new Error("fireLatest: no timers armed");
      }
      const id = ids[ids.length - 1];
      const t = /** @type {{ fn: () => void, ms: number }} */ (timers.get(id));
      timers.delete(id);
      t.fn();
    },
    /** Synchronously fire a specific handle. */
    fire: (id) => {
      const t = timers.get(id);
      if (t == null) throw new Error(`fire: no timer for id=${id}`);
      timers.delete(id);
      t.fn();
    },
  };
}

describe("clientTempIdRegistry", () => {
  describe("resolve", () => {
    it("settles the registered deferred with the supplied payload", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const pending = reg.register("tmp-1");
      const settled = reg.resolve("tmp-1", { _id: "srv-1" });
      expect(settled).toBe(true);
      await expect(pending).resolves.toEqual({ _id: "srv-1" });
    });

    it("returns false when no deferred is registered for the id", () => {
      const reg = createClientTempIdRegistry();
      expect(reg.resolve("never-registered", { _id: "x" })).toBe(false);
    });

    it("returns false for invalid ids without throwing", () => {
      const reg = createClientTempIdRegistry();
      expect(reg.resolve(/** @type {any} */ (""), {})).toBe(false);
      expect(reg.resolve(/** @type {any} */ (null), {})).toBe(false);
      expect(reg.resolve(/** @type {any} */ (undefined), {})).toBe(false);
    });

    it("clears the pending timer so a late timeout does not fire", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const pending = reg.register("tmp-1", { timeoutMs: 1_000 });
      expect(sched.pending()).toBe(1);
      reg.resolve("tmp-1", "ok");
      // The timer must be cleared the moment the deferred settles.
      expect(sched.pending()).toBe(0);
      await expect(pending).resolves.toBe("ok");
    });

    it("removes the entry from the pending set", async () => {
      const reg = createClientTempIdRegistry();
      const pending = reg.register("tmp-1", { timeoutMs: 0 });
      expect(reg.has("tmp-1")).toBe(true);
      expect(reg._size()).toBe(1);
      reg.resolve("tmp-1", "ok");
      expect(reg.has("tmp-1")).toBe(false);
      expect(reg._size()).toBe(0);
      await pending;
    });
  });

  describe("reject", () => {
    it("rejects the deferred with the supplied Error", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const pending = reg.register("tmp-1");
      const err = Object.assign(new Error("MESSAGE_SEND_FAILED"), {
        code: "MESSAGE_SEND_FAILED",
      });
      const settled = reg.reject("tmp-1", err);
      expect(settled).toBe(true);
      await expect(pending).rejects.toMatchObject({
        message: "MESSAGE_SEND_FAILED",
        code: "MESSAGE_SEND_FAILED",
      });
    });

    it("wraps a string error in an Error instance", async () => {
      const reg = createClientTempIdRegistry();
      const pending = reg.register("tmp-1");
      const settled = reg.reject("tmp-1", "boom");
      expect(settled).toBe(true);
      await expect(pending).rejects.toBeInstanceOf(Error);
      await expect(pending).rejects.toThrow("boom");
    });

    it("returns false when no deferred is registered for the id", () => {
      const reg = createClientTempIdRegistry();
      expect(reg.reject("never-registered", new Error("nope"))).toBe(false);
    });

    it("returns false for invalid ids without throwing", () => {
      const reg = createClientTempIdRegistry();
      expect(reg.reject(/** @type {any} */ (""), new Error("nope"))).toBe(
        false,
      );
      expect(reg.reject(/** @type {any} */ (null), new Error("nope"))).toBe(
        false,
      );
    });

    it("clears the pending timer so a late timeout cannot replace the rejection", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const pending = reg.register("tmp-1", { timeoutMs: 1_000 });
      expect(sched.pending()).toBe(1);
      reg.reject("tmp-1", "boom");
      expect(sched.pending()).toBe(0);
      await expect(pending).rejects.toThrow("boom");
    });

    it("removes the entry from the pending set", async () => {
      const reg = createClientTempIdRegistry();
      const pending = reg.register("tmp-1");
      expect(reg.has("tmp-1")).toBe(true);
      reg.reject("tmp-1", new Error("nope"));
      expect(reg.has("tmp-1")).toBe(false);
      expect(reg._size()).toBe(0);
      // Surface and silence the rejection so it does not show up as
      // unhandled in the test runner.
      await pending.catch(() => undefined);
    });
  });

  describe("timeout", () => {
    it("rejects with TIMEOUT when the timer elapses before resolve/reject", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const pending = reg.register("tmp-1", { timeoutMs: 5_000 });
      expect(sched.pending()).toBe(1);
      sched.fireLatest();
      await expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
        clientTempId: "tmp-1",
        timeoutMs: 5_000,
      });
      // The entry must be removed when the timer fires so a subsequent
      // resolve / reject is a no-op.
      expect(reg.has("tmp-1")).toBe(false);
      expect(reg.resolve("tmp-1", "late")).toBe(false);
    });

    it("uses the explicit timeoutMs option over the registry default", () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        defaultTimeoutMs: 30_000,
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      reg.register("tmp-1", { timeoutMs: 1_234 });
      const ids = sched.ids();
      expect(ids.length).toBe(1);
      expect(sched.msFor(ids[0])).toBe(1_234);
    });

    it("falls back to defaultTimeoutMs when timeoutMs is omitted", () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        defaultTimeoutMs: 7_500,
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      reg.register("tmp-1");
      const ids = sched.ids();
      expect(ids.length).toBe(1);
      expect(sched.msFor(ids[0])).toBe(7_500);
    });

    it("falls back to DEFAULT_TIMEOUT_MS (30s) when no override is supplied", () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      reg.register("tmp-1");
      const ids = sched.ids();
      expect(ids.length).toBe(1);
      expect(sched.msFor(ids[0])).toBe(DEFAULT_TIMEOUT_MS);
      expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    });

    it("does not arm a timer when timeoutMs is 0", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const pending = reg.register("tmp-1", { timeoutMs: 0 });
      expect(sched.pending()).toBe(0);
      reg.resolve("tmp-1", "ok");
      await expect(pending).resolves.toBe("ok");
    });
  });

  describe("replace-on-re-register", () => {
    it("rejects the previous deferred with REPLACED when the same id is re-registered", async () => {
      const reg = createClientTempIdRegistry();
      const first = reg.register("tmp-1");
      const second = reg.register("tmp-1");
      await expect(first).rejects.toMatchObject({
        message: "REPLACED",
        code: "REPLACED",
      });
      reg.resolve("tmp-1", "ok");
      await expect(second).resolves.toBe("ok");
    });

    it("clears the previous deferred's timer on replacement", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const first = reg.register("tmp-1", { timeoutMs: 5_000 });
      expect(sched.pending()).toBe(1);
      const second = reg.register("tmp-1", { timeoutMs: 9_999 });
      // Exactly one timer remains armed (the second one).
      expect(sched.pending()).toBe(1);
      const ids = sched.ids();
      expect(sched.msFor(ids[0])).toBe(9_999);
      await expect(first).rejects.toMatchObject({ code: "REPLACED" });
      reg.resolve("tmp-1", "second-wins");
      await expect(second).resolves.toBe("second-wins");
      expect(sched.pending()).toBe(0);
    });

    it("does not affect deferreds for unrelated ids", async () => {
      const reg = createClientTempIdRegistry();
      const otherPending = reg.register("tmp-other");
      const first = reg.register("tmp-1");
      const second = reg.register("tmp-1");
      await expect(first).rejects.toMatchObject({ code: "REPLACED" });
      reg.resolve("tmp-other", "other-ok");
      reg.resolve("tmp-1", "1-ok");
      await expect(otherPending).resolves.toBe("other-ok");
      await expect(second).resolves.toBe("1-ok");
    });
  });

  describe("has and _size", () => {
    it("reflects the live pending set across register and resolve", async () => {
      const reg = createClientTempIdRegistry();
      expect(reg._size()).toBe(0);
      expect(reg.has("tmp-1")).toBe(false);

      const p1 = reg.register("tmp-1");
      const p2 = reg.register("tmp-2");
      expect(reg._size()).toBe(2);
      expect(reg.has("tmp-1")).toBe(true);
      expect(reg.has("tmp-2")).toBe(true);
      expect(reg.has("tmp-3")).toBe(false);

      reg.resolve("tmp-1", "ok-1");
      expect(reg._size()).toBe(1);
      expect(reg.has("tmp-1")).toBe(false);
      expect(reg.has("tmp-2")).toBe(true);

      reg.resolve("tmp-2", "ok-2");
      expect(reg._size()).toBe(0);
      await Promise.all([p1, p2]);
    });

    it("returns false from has() for invalid ids", () => {
      const reg = createClientTempIdRegistry();
      expect(reg.has(/** @type {any} */ (""))).toBe(false);
      expect(reg.has(/** @type {any} */ (null))).toBe(false);
      expect(reg.has(/** @type {any} */ (undefined))).toBe(false);
    });
  });

  describe("concurrent deferreds with different keys", () => {
    it("resolves only the matching key, leaves others pending", async () => {
      const reg = createClientTempIdRegistry();
      const a = reg.register("tmp-a");
      const b = reg.register("tmp-b");
      const c = reg.register("tmp-c");
      reg.resolve("tmp-b", { id: "B" });
      // Only tmp-b should have been removed.
      expect(reg.has("tmp-a")).toBe(true);
      expect(reg.has("tmp-b")).toBe(false);
      expect(reg.has("tmp-c")).toBe(true);
      await expect(b).resolves.toEqual({ id: "B" });
      reg.resolve("tmp-a", { id: "A" });
      reg.reject("tmp-c", new Error("c-fail"));
      await expect(a).resolves.toEqual({ id: "A" });
      await expect(c).rejects.toThrow("c-fail");
      expect(reg._size()).toBe(0);
    });

    it("isolates timeouts per key", async () => {
      const sched = makeFakeScheduler();
      const reg = createClientTempIdRegistry({
        setTimeout: sched.setTimeoutFn,
        clearTimeout: sched.clearTimeoutFn,
      });
      const a = reg.register("tmp-a", { timeoutMs: 1_000 });
      const b = reg.register("tmp-b", { timeoutMs: 1_000 });
      const aTimerId = sched.ids()[0];
      // Fire only tmp-a's timer.
      sched.fire(aTimerId);
      await expect(a).rejects.toMatchObject({
        code: "TIMEOUT",
        clientTempId: "tmp-a",
      });
      // tmp-b is still pending.
      expect(reg.has("tmp-b")).toBe(true);
      reg.resolve("tmp-b", "b-ok");
      await expect(b).resolves.toBe("b-ok");
    });
  });

  describe("invalid register inputs", () => {
    it("rejects with INVALID_CLIENT_TEMP_ID when id is empty", async () => {
      const reg = createClientTempIdRegistry();
      await expect(reg.register(/** @type {any} */ (""))).rejects.toMatchObject({
        code: "INVALID_CLIENT_TEMP_ID",
      });
    });

    it("rejects with INVALID_CLIENT_TEMP_ID when id is not a string", async () => {
      const reg = createClientTempIdRegistry();
      await expect(reg.register(/** @type {any} */ (null))).rejects.toMatchObject({
        code: "INVALID_CLIENT_TEMP_ID",
      });
      await expect(
        reg.register(/** @type {any} */ (123)),
      ).rejects.toMatchObject({ code: "INVALID_CLIENT_TEMP_ID" });
    });
  });

  describe("module-level singleton", () => {
    it("getClientTempIdRegistry returns a stable instance and reset clears it", () => {
      __resetClientTempIdRegistryForTests();
      const a = getClientTempIdRegistry();
      const b = getClientTempIdRegistry();
      expect(a).toBe(b);
      __resetClientTempIdRegistryForTests();
      const c = getClientTempIdRegistry();
      expect(c).not.toBe(a);
      __resetClientTempIdRegistryForTests();
    });
  });
});
