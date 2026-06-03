import { describe, it, expect, beforeEach } from "vitest";

import {
  STATUS_RANK,
  rank,
  monotonicMaxStatus,
} from "./statusLifecycle.js";
import {
  __resetDiagnosticsSingletonForTests,
  getDiagnostics,
} from "../utils/Diagnostics.js";

/**
 * Unit tests for the status-lifecycle helper exported by `statusLifecycle.js`.
 *
 *   - Validates the rank table from §3.6 of the design.
 *   - Validates `monotonicMaxStatus` accepts forward moves, the sanctioned
 *     `failed → pending` retry, and rejects backwards moves on non-failed
 *     rows (Req 7.5, 7.6).
 *   - Validates the Diagnostics `STATUS_BACKWARDS_IGNORED` log emission
 *     (Req 7.6).
 */
describe("statusLifecycle.rank()", () => {
  it("matches the design's rank table", () => {
    expect(STATUS_RANK).toEqual({
      failed: 0,
      pending: 1,
      sent: 2,
      delivered: 3,
      read: 4,
    });
    expect(rank("failed")).toBe(0);
    expect(rank("pending")).toBe(1);
    expect(rank("sent")).toBe(2);
    expect(rank("delivered")).toBe(3);
    expect(rank("read")).toBe(4);
  });

  it("returns -1 for unknown / null / undefined statuses", () => {
    expect(rank(null)).toBe(-1);
    expect(rank(undefined)).toBe(-1);
    expect(rank("")).toBe(-1);
    expect(rank("nonsense")).toBe(-1);
  });
});

describe("statusLifecycle.monotonicMaxStatus()", () => {
  beforeEach(() => {
    __resetDiagnosticsSingletonForTests();
  });

  it("accepts forward progression along the lifecycle", () => {
    expect(monotonicMaxStatus("pending", "sent")).toBe("sent");
    expect(monotonicMaxStatus("sent", "delivered")).toBe("delivered");
    expect(monotonicMaxStatus("delivered", "read")).toBe("read");
  });

  it("returns the server value when ranks are equal (server is authoritative on ties)", () => {
    expect(monotonicMaxStatus("read", "read")).toBe("read");
    expect(monotonicMaxStatus("delivered", "delivered")).toBe("delivered");
  });

  it("allows the sanctioned failed → pending retry (Req 7.5)", () => {
    expect(monotonicMaxStatus("failed", "pending")).toBe("pending");
  });

  it("allows failed → sent / delivered / read when the server later confirms", () => {
    expect(monotonicMaxStatus("failed", "sent")).toBe("sent");
    expect(monotonicMaxStatus("failed", "delivered")).toBe("delivered");
    expect(monotonicMaxStatus("failed", "read")).toBe("read");
  });

  it("ignores backwards moves on non-failed rows and logs STATUS_BACKWARDS_IGNORED (Req 7.6)", () => {
    const result = monotonicMaxStatus("read", "delivered");
    expect(result).toBe("read");

    const events = getDiagnostics().snapshot().events;
    expect(events.length).toBe(1);
    expect(events[0].code).toBe("STATUS_BACKWARDS_IGNORED");
    expect(events[0].category).toBe("live");
    expect(events[0].outcome).toBe("warn");
    expect(events[0].meta).toEqual({
      localStatus: "read",
      serverStatus: "delivered",
    });
  });

  it("ignores deeper backwards moves (read → pending, delivered → pending, sent → pending)", () => {
    expect(monotonicMaxStatus("read", "pending")).toBe("read");
    expect(monotonicMaxStatus("delivered", "pending")).toBe("delivered");
    expect(monotonicMaxStatus("sent", "pending")).toBe("sent");
    const events = getDiagnostics().snapshot().events;
    expect(events.length).toBe(3);
    for (const e of events) expect(e.code).toBe("STATUS_BACKWARDS_IGNORED");
  });

  it("returns the server status when the local status is null/undefined", () => {
    expect(monotonicMaxStatus(null, "sent")).toBe("sent");
    expect(monotonicMaxStatus(undefined, "pending")).toBe("pending");
  });

  it("returns the local status when the server status is null/undefined", () => {
    expect(monotonicMaxStatus("delivered", null)).toBe("delivered");
    expect(monotonicMaxStatus("delivered", undefined)).toBe("delivered");
  });

  it("does not demote a non-failed local row when the server sends an unknown status", () => {
    // Unknown status has rank -1, which is < every known rank. On a non-failed
    // local row this is treated as a backwards move and dropped.
    const out = monotonicMaxStatus("delivered", "garbage");
    expect(out).toBe("delivered");
  });
});
