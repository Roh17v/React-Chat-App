// @ts-check
/**
 * Unit tests for the ChatSlice actions, focused on
 * `applySubscriptionSnapshot` (the smart-merge used by the live
 * `subscribeMessages` callback in MessageContainer).
 *
 * The action has to handle four distinct scenarios correctly:
 *   1. Chat-open — state is empty, snapshot populates the window.
 *   2. Live tail append — a new message at the tail is appended; the
 *      user's existing scroll position is preserved.
 *   3. Status update — a message in the snapshot carries a fresher
 *      `status` / `deletedForEveryone` / `content` than the state;
 *      the state row is updated in place without losing any other
 *      fields (notably UI-only ones like `_stableKey`, `isOptimistic`).
 *   4. Pagination preservation — the state holds older messages
 *      outside the snapshot's window; the merge must NOT throw those
 *      away, otherwise a live event while the user is scrolled up
 *      kicks them back to the newest 50.
 *
 * These tests exercise the slice's `set`/`get` plumbing directly so
 * the assertions are independent of React or any component.
 */

import { describe, it, expect } from "vitest";

import { createChatSlice } from "./ChatSlice.js";

/**
 * Build a minimal store-like object exposing only the slice's
 * `set` and `get` so the action can be exercised in isolation.
 */
function makeSlice() {
  /** @type {Record<string, any>} */
  const state = {};
  const set = (updater) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    Object.assign(state, next);
  };
  const get = () => state;
  Object.assign(state, createChatSlice(set, get));
  return /** @type {ReturnType<typeof createChatSlice> & { selectedChatMessages: any[] }} */ (state);
}

/** @param {Partial<{_id: string, createdAt: string, status: string, content: string, deletedForEveryone: boolean, _stableKey: string, isOptimistic: boolean}>} overrides */
function msg(overrides = {}) {
  return {
    _id: overrides._id,
    createdAt: overrides.createdAt,
    status: overrides.status ?? "sent",
    // `in` check preserves explicit `null` (vs `undefined` which is the
    // "not provided" signal). The action's content-update path needs to
    // see `null` as the new value when a deletion clears the row.
    content: "content" in overrides ? overrides.content : "",
    deletedForEveryone: overrides.deletedForEveryone ?? false,
    ...(overrides._stableKey !== undefined ? { _stableKey: overrides._stableKey } : {}),
    ...(overrides.isOptimistic !== undefined ? { isOptimistic: overrides.isOptimistic } : {}),
  };
}

describe("ChatSlice.applySubscriptionSnapshot", () => {
  it("populates an empty state from the snapshot (chat-open case)", () => {
    const slice = makeSlice();
    const snapshot = [
      msg({ _id: "m51", createdAt: "2024-01-01T00:51:00.000Z", content: "a" }),
      msg({ _id: "m52", createdAt: "2024-01-01T00:52:00.000Z", content: "b" }),
      msg({ _id: "m53", createdAt: "2024-01-01T00:53:00.000Z", content: "c" }),
    ];
    slice.applySubscriptionSnapshot(snapshot);
    expect(slice.selectedChatMessages.map((m) => m._id)).toEqual([
      "m51",
      "m52",
      "m53",
    ]);
  });

  it("appends a new tail message without disturbing the existing window", () => {
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" }),
        msg({ _id: "m51", createdAt: "2024-01-01T00:51:00.000Z" }),
      ],
      true,
    );
    slice.applySubscriptionSnapshot([
      msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" }),
      msg({ _id: "m51", createdAt: "2024-01-01T00:51:00.000Z" }),
      msg({ _id: "m52", createdAt: "2024-01-01T00:52:00.000Z", content: "new" }),
    ]);
    expect(slice.selectedChatMessages.map((m) => m._id)).toEqual([
      "m50",
      "m51",
      "m52",
    ]);
    expect(slice.selectedChatMessages[2].content).toBe("new");
  });

  it("PRESERVES paginated-in older messages when a live event fires (the user-reported bug)", () => {
    // This is the regression test for the scroll-up-destruction bug.
    // The state holds messages paged in by scroll-up that are NOT in
    // the newest-50 snapshot. The merge must keep them, not throw
    // them away like a `setSelectedChatMessages(snapshot, true)` reset
    // would.
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({ _id: "m31", createdAt: "2024-01-01T00:31:00.000Z" }),
        msg({ _id: "m32", createdAt: "2024-01-01T00:32:00.000Z" }),
        msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" }),
        msg({ _id: "m51", createdAt: "2024-01-01T00:51:00.000Z" }),
      ],
      true,
    );
    // Snapshot is the newest 50 — only m52..m100 in this test.
    const snapshot = [
      msg({ _id: "m52", createdAt: "2024-01-01T00:52:00.000Z", content: "fresh" }),
    ];
    slice.applySubscriptionSnapshot(snapshot);
    // m31, m32, m50, m51, m52 — pagination preserved, new tail appended.
    expect(slice.selectedChatMessages.map((m) => m._id)).toEqual([
      "m31",
      "m32",
      "m50",
      "m51",
      "m52",
    ]);
  });

  it("updates the status field in place when the snapshot has a fresher value", () => {
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({
          _id: "m50",
          createdAt: "2024-01-01T00:50:00.000Z",
          status: "delivered",
        }),
      ],
      true,
    );
    slice.applySubscriptionSnapshot([
      msg({
        _id: "m50",
        createdAt: "2024-01-01T00:50:00.000Z",
        status: "read",
      }),
    ]);
    expect(slice.selectedChatMessages).toHaveLength(1);
    expect(slice.selectedChatMessages[0].status).toBe("read");
  });

  it("preserves UI-only fields (_stableKey, isOptimistic) on in-place updates", () => {
    // The optimistic lifecycle: the queue writes the real message to
    // the DB, the conflict resolver merges it onto the optimistic
    // row, the snapshot then has the merged row with a fresher
    // `status` / `server_id`. The merge must keep the optimistic's
    // `_stableKey` and `isOptimistic` flags so React's key-based
    // reconciliation doesn't tear the bubble out of the DOM.
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({
          _id: "tmp-1",
          createdAt: "2024-01-01T00:50:00.000Z",
          status: "pending",
          _stableKey: "tmp-1",
          isOptimistic: true,
        }),
      ],
      true,
    );
    slice.applySubscriptionSnapshot([
      msg({
        _id: "tmp-1",
        createdAt: "2024-01-01T00:50:00.000Z",
        status: "sent",
      }),
    ]);
    expect(slice.selectedChatMessages).toHaveLength(1);
    expect(slice.selectedChatMessages[0].status).toBe("sent");
    expect(slice.selectedChatMessages[0]._stableKey).toBe("tmp-1");
    expect(slice.selectedChatMessages[0].isOptimistic).toBe(true);
  });

  it("handles offline-sync catch-up: prepends older messages AND appends newer ones in one call", () => {
    // User was offline, peer sent 5 older messages + 3 newer messages
    // before they came back online. Periodic sync fetches them all.
    // The merge must place each at the correct ascending position.
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({ _id: "m96", createdAt: "2024-01-01T00:96:00.000Z" }),
        msg({ _id: "m97", createdAt: "2024-01-01T00:97:00.000Z" }),
        msg({ _id: "m98", createdAt: "2024-01-01T00:98:00.000Z" }),
        msg({ _id: "m99", createdAt: "2024-01-01T00:99:00.000Z" }),
        msg({ _id: "m100", createdAt: "2024-01-01T01:00:00.000Z" }),
      ],
      true,
    );
    // Snapshot brings in m91..m95 (older) and m101..m103 (newer).
    const snapshot = [
      msg({ _id: "m91", createdAt: "2024-01-01T00:91:00.000Z" }),
      msg({ _id: "m92", createdAt: "2024-01-01T00:92:00.000Z" }),
      msg({ _id: "m93", createdAt: "2024-01-01T00:93:00.000Z" }),
      msg({ _id: "m94", createdAt: "2024-01-01T00:94:00.000Z" }),
      msg({ _id: "m95", createdAt: "2024-01-01T00:95:00.000Z" }),
      msg({ _id: "m96", createdAt: "2024-01-01T00:96:00.000Z" }),
      msg({ _id: "m97", createdAt: "2024-01-01T00:97:00.000Z" }),
      msg({ _id: "m98", createdAt: "2024-01-01T00:98:00.000Z" }),
      msg({ _id: "m99", createdAt: "2024-01-01T00:99:00.000Z" }),
      msg({ _id: "m100", createdAt: "2024-01-01T01:00:00.000Z" }),
      msg({ _id: "m101", createdAt: "2024-01-01T01:01:00.000Z" }),
      msg({ _id: "m102", createdAt: "2024-01-01T01:02:00.000Z" }),
      msg({ _id: "m103", createdAt: "2024-01-01T01:03:00.000Z" }),
    ];
    slice.applySubscriptionSnapshot(snapshot);
    expect(slice.selectedChatMessages.map((m) => m._id)).toEqual([
      "m91",
      "m92",
      "m93",
      "m94",
      "m95",
      "m96",
      "m97",
      "m98",
      "m99",
      "m100",
      "m101",
      "m102",
      "m103",
    ]);
  });

  it("inserts a new message that lands between the state's head and tail", () => {
    // Edge case: a sync brings in a message that is neither the
    // oldest nor the newest in the existing window — e.g. a
    // server-side correction or a message received out-of-order
    // via two different paths.
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" }),
        msg({ _id: "m52", createdAt: "2024-01-01T00:52:00.000Z" }),
      ],
      true,
    );
    slice.applySubscriptionSnapshot([
      msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" }),
      msg({ _id: "m51", createdAt: "2024-01-01T00:51:00.000Z", content: "middle" }),
      msg({ _id: "m52", createdAt: "2024-01-01T00:52:00.000Z" }),
    ]);
    expect(slice.selectedChatMessages.map((m) => m._id)).toEqual([
      "m50",
      "m51",
      "m52",
    ]);
    expect(slice.selectedChatMessages[1].content).toBe("middle");
  });

  it("is a no-op when the snapshot is empty or invalid", () => {
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" })],
      true,
    );
    const before = slice.selectedChatMessages;
    slice.applySubscriptionSnapshot([]);
    slice.applySubscriptionSnapshot(null);
    slice.applySubscriptionSnapshot(undefined);
    expect(slice.selectedChatMessages).toBe(before);
  });

  it("is a no-op when the snapshot matches the state field-for-field (no re-render)", () => {
    // Zustand returns a new object from `set`, so we check by
    // reference: if the action returned `{}`, the slice didn't
    // allocate a new `selectedChatMessages` array.
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z", status: "read" }),
      ],
      true,
    );
    const refBefore = slice.selectedChatMessages;
    slice.applySubscriptionSnapshot([
      msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z", status: "read" }),
    ]);
    // No field change → no new array allocation.
    expect(slice.selectedChatMessages).toBe(refBefore);
  });

  it("applies deletedForEveryone: true from the snapshot (deletion-for-everyone case)", () => {
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [
        msg({
          _id: "m50",
          createdAt: "2024-01-01T00:50:00.000Z",
          content: "secret",
          deletedForEveryone: false,
        }),
      ],
      true,
    );
    slice.applySubscriptionSnapshot([
      msg({
        _id: "m50",
        createdAt: "2024-01-01T00:50:00.000Z",
        content: null,
        deletedForEveryone: true,
      }),
    ]);
    expect(slice.selectedChatMessages[0].deletedForEveryone).toBe(true);
    expect(slice.selectedChatMessages[0].content).toBeNull();
  });

  it("handles a message with missing createdAt defensively (appends to tail)", () => {
    // A malformed payload must not silently lose the message; the
    // safest fallback is to append it at the tail.
    const slice = makeSlice();
    slice.setSelectedChatMessages(
      [msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" })],
      true,
    );
    slice.applySubscriptionSnapshot([
      msg({ _id: "m50", createdAt: "2024-01-01T00:50:00.000Z" }),
      { _id: "m-bad", status: "sent", content: "no timestamp" },
    ]);
    expect(slice.selectedChatMessages.map((m) => m._id)).toEqual([
      "m50",
      "m-bad",
    ]);
  });
});
