import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createDiagnostics } from "./Diagnostics.js";

/**
 * Property 21: Diagnostics ring buffer bounded retention.
 *
 * For any sequence of N calls to Diagnostics.log(event), the snapshot:
 *   1. has length === min(N, capacity) (with capacity = 200);
 *   2. contains the most recent min(N, capacity) events in chronological order;
 *   3. has timestamps that are monotonically non-decreasing.
 *
 * Validates: Requirements 14.1
 */

const capacityArb = fc.constant(200);

const logEventArb = fc.record({
  category: fc.constantFrom(
    "boot",
    "migration",
    "bootstrap",
    "incremental",
    "live",
    "outbound",
    "media",
    "encryption",
    "error",
  ),
  code: fc.string({ minLength: 1, maxLength: 24 }),
  outcome: fc.constantFrom("ok", "warn", "error"),
  durationMs: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: undefined }),
});

describe("Diagnostics ring buffer bounded retention (Property 21)", () => {
  it("snapshot.events.length === min(N, capacity), is chronological, and ts is non-decreasing", () => {
    fc.assert(
      fc.property(
        capacityArb,
        // N spans below, at, and above capacity so the wrap-around branch is exercised.
        fc.array(logEventArb, { minLength: 0, maxLength: 600 }),
        // Inject jitter + occasional clock regressions to verify the monotonic guarantee.
        fc.array(fc.integer({ min: -5, max: 50 }), { minLength: 0, maxLength: 600 }),
        (capacity, events, deltas) => {
          let nowMs = 1_700_000_000_000;
          let step = 0;
          const diag = createDiagnostics({
            capacity,
            now: () => {
              const v = nowMs;
              const delta = deltas.length > 0 ? deltas[step % deltas.length] : 1;
              step += 1;
              nowMs += delta;
              return v;
            },
          });

          for (const e of events) diag.log(e);

          const snap = diag.snapshot();
          const expectedLen = Math.min(events.length, capacity);

          expect(snap.events.length).toBe(expectedLen);

          // Most recent N events (chronological order, oldest first).
          const expectedSlice = events.slice(events.length - expectedLen);
          for (let i = 0; i < expectedLen; i += 1) {
            expect(snap.events[i].category).toBe(expectedSlice[i].category);
            expect(snap.events[i].code).toBe(expectedSlice[i].code);
            expect(snap.events[i].outcome).toBe(expectedSlice[i].outcome);
            if (expectedSlice[i].durationMs === undefined) {
              expect(snap.events[i].durationMs).toBeUndefined();
            } else {
              expect(snap.events[i].durationMs).toBe(expectedSlice[i].durationMs);
            }
          }

          // Timestamps are strings; compare via Date.parse for monotonicity.
          for (let i = 1; i < snap.events.length; i += 1) {
            const prev = Date.parse(snap.events[i - 1].ts);
            const cur = Date.parse(snap.events[i].ts);
            expect(cur).toBeGreaterThanOrEqual(prev);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never exceeds capacity even after very long log streams", () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 5_000 }), (n) => {
        const diag = createDiagnostics({ capacity: 200 });
        for (let i = 0; i < n; i += 1) {
          diag.log({ category: "boot", code: `C${i}`, outcome: "ok" });
        }
        const snap = diag.snapshot();
        expect(snap.events.length).toBe(200);
        // Last event in the snapshot must match the last logged code.
        expect(snap.events[snap.events.length - 1].code).toBe(`C${n - 1}`);
        // First event in the snapshot must be the (n - 200)th logged code.
        expect(snap.events[0].code).toBe(`C${n - 200}`);
      }),
      { numRuns: 50 },
    );
  });
});
