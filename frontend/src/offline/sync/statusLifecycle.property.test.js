import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  STATUS_RANK,
  rank,
  monotonicMaxStatus,
} from "./statusLifecycle.js";
import { __resetDiagnosticsSingletonForTests } from "../utils/Diagnostics.js";

/**
 * Property 12: Status lifecycle monotonicity.
 *
 * Define `rank(failed) = 0`, `rank(pending) = 1`, `rank(sent) = 2`,
 * `rank(delivered) = 3`, `rank(read) = 4`. For any single message and any
 * sequence of status updates `s_1, s_2, …, s_n` reduced via
 * `monotonicMaxStatus(local, s_i)`, the post-state's status `s_final`
 * satisfies `rank(s_final) = max(rank(s_i))` over the applied sequence —
 * with the explicit `failed → pending` retry exception (which is naturally
 * satisfied because `rank(pending) > rank(failed)`).
 *
 * Validates: Requirements 6.4, 7.4, 7.5, 7.6
 */

const STATUS_VALUES = /** @type {const} */ ([
  "failed",
  "pending",
  "sent",
  "delivered",
  "read",
]);

const statusArb = fc.constantFrom(...STATUS_VALUES);
const initialStatusArb = fc.constantFrom(...STATUS_VALUES);

describe("Property 12: Status lifecycle monotonicity (Req 6.4, 7.4, 7.5, 7.6)", () => {
  it("rank(s_final) === max(rank(s_i)) over any update sequence", () => {
    fc.assert(
      fc.property(
        initialStatusArb,
        fc.array(statusArb, { minLength: 0, maxLength: 50 }),
        (initial, updates) => {
          __resetDiagnosticsSingletonForTests();

          let state = initial;
          let maxRank = rank(initial);
          for (const s of updates) {
            state = monotonicMaxStatus(state, s);
            maxRank = Math.max(maxRank, rank(s));
          }

          expect(rank(state)).toBe(maxRank);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the resulting status is always a known lifecycle value", () => {
    fc.assert(
      fc.property(
        initialStatusArb,
        fc.array(statusArb, { minLength: 0, maxLength: 50 }),
        (initial, updates) => {
          __resetDiagnosticsSingletonForTests();
          let state = initial;
          for (const s of updates) state = monotonicMaxStatus(state, s);
          expect(STATUS_RANK).toHaveProperty(state);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("the rank sequence is monotonically non-decreasing across the reduction", () => {
    fc.assert(
      fc.property(
        initialStatusArb,
        fc.array(statusArb, { minLength: 0, maxLength: 50 }),
        (initial, updates) => {
          __resetDiagnosticsSingletonForTests();
          let state = initial;
          let prev = rank(initial);
          for (const s of updates) {
            state = monotonicMaxStatus(state, s);
            const cur = rank(state);
            expect(cur).toBeGreaterThanOrEqual(prev);
            prev = cur;
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("explicit failed → pending retry is sanctioned (Req 7.5)", () => {
    // Direct property: starting at `failed`, the first non-failed update of
    // any rank wins. Specifically `pending` is accepted (the retry case the
    // spec calls out). We pin this with a focused fast-check to make the
    // intent obvious to readers of the test file.
    fc.assert(
      fc.property(
        fc.constantFrom("pending", "sent", "delivered", "read"),
        (next) => {
          __resetDiagnosticsSingletonForTests();
          expect(monotonicMaxStatus("failed", next)).toBe(next);
        },
      ),
      { numRuns: 100 },
    );
  });
});
