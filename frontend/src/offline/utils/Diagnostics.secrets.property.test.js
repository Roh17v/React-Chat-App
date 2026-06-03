import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createDiagnostics } from "./Diagnostics.js";

/**
 * Property 22: Diagnostics excludes user content and secrets.
 *
 * Drive a sequence of fake repository, sync, and outbound queue operations
 * whose payloads include random `messages.content`, file bytes, and a fake
 * auth token. Assert that `Diagnostics.toClipboardText()` does not contain any
 * of those values.
 *
 * Validates: Requirements 14.4
 */

// Generate strings long enough that a chance collision with TSV column names is
// effectively impossible, but small enough to keep the test fast.
const sensitiveStringArb = fc.string({ minLength: 12, maxLength: 64 }).filter(
  (s) => s.length > 0 && /[A-Za-z0-9]/.test(s),
);

const tokenArb = fc
  .tuple(
    fc.constantFrom("Bearer", "Token", "JWT"),
    fc.string({ minLength: 24, maxLength: 64 }),
  )
  .map(([prefix, body]) => `${prefix} ${body.replace(/\s/g, "x")}`);

const fileBytesArb = fc.uint8Array({ minLength: 8, maxLength: 256 });

/**
 * @typedef {Object} FakeOp
 * @property {"repo" | "sync" | "queue" | "media"} kind
 * @property {string} content   message content the op "saw"
 * @property {Uint8Array} fileBytes raw file bytes the op "saw"
 * @property {string} token     auth token the op "saw"
 */

const opArb = fc.record({
  kind: fc.constantFrom("repo", "sync", "queue", "media"),
  content: sensitiveStringArb,
  fileBytes: fileBytesArb,
  token: tokenArb,
});

/**
 * Stand-in for the real wire-up: feeds an operation through the offline layer
 * and records what it would log. This mirrors the sanitization contract we
 * expect every caller to follow:
 *
 *   - never pass message content under non-secret keys,
 *   - never pass raw file bytes,
 *   - never pass auth tokens.
 *
 * The Diagnostics module strips secret-looking keys and replaces binary values
 * with a `<bytes:N>` placeholder, so even if a careless caller does include
 * those values under one of the SECRET_KEY_HINTS keys, the output stays clean.
 */
function driveFakeOperation(diag, op) {
  switch (op.kind) {
    case "repo":
      diag.log({
        category: "live",
        code: "REPO_APPLY_LIVE",
        outcome: "ok",
        durationMs: 4,
        meta: {
          // A careless caller might pass these. Sanitizer must drop them.
          content: op.content,
          authToken: op.token,
          fileBody: op.fileBytes,
          // Non-secret meta is preserved.
          conversationId: "conv-1",
          messageType: "text",
        },
      });
      break;
    case "sync":
      diag.log({
        category: "incremental",
        code: "SYNC_BATCH_APPLIED",
        outcome: "ok",
        durationMs: 12,
        meta: {
          authorization: op.token,
          rowCount: 5,
          // Sanitizer drops "secret"-bearing keys recursively.
          headers: { Authorization: op.token, "x-secret": "shh" },
        },
      });
      break;
    case "queue":
      diag.log({
        category: "outbound",
        code: "QUEUE_DRAIN_ATTEMPT",
        outcome: "warn",
        durationMs: 30,
        meta: {
          // The queue should never log the message body, but if it slips
          // through under a "content" key, sanitization protects us.
          content: op.content,
          queueSeq: 7,
          attempt: 2,
        },
      });
      break;
    case "media":
      diag.log({
        category: "media",
        code: "MEDIA_DOWNLOAD_OK",
        outcome: "ok",
        durationMs: 200,
        meta: {
          // Raw bytes must never end up in clipboard text.
          fileBytes: op.fileBytes,
          byteSize: op.fileBytes.byteLength,
          mime: "application/octet-stream",
        },
      });
      break;
    default:
      break;
  }
}

/**
 * Convert a Uint8Array to its raw character representation (each byte → one
 * code unit). If any of those bytes ever show up in the clipboard text, this
 * substring will be present.
 */
function bytesToString(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

describe("Diagnostics secret exclusion (Property 22)", () => {
  it("toClipboardText() never contains message content, file bytes, or auth tokens", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const diag = createDiagnostics({ capacity: 200 });
        for (const op of ops) driveFakeOperation(diag, op);

        const text = diag.toClipboardText();

        for (const op of ops) {
          // Skip extremely short or trivial values that could legitimately show
          // up in unrelated columns. The arbitrary already filters minLength 12
          // and ensures alphanumerics, so collisions are negligible.
          expect(text).not.toContain(op.content);
          expect(text).not.toContain(op.token);

          const bytesAsString = bytesToString(op.fileBytes);
          if (bytesAsString.length >= 8) {
            expect(text).not.toContain(bytesAsString);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("preserves non-secret meta fields after sanitization", () => {
    const diag = createDiagnostics({ capacity: 10 });
    diag.log({
      category: "incremental",
      code: "SYNC_BATCH_APPLIED",
      outcome: "ok",
      durationMs: 12,
      meta: { authToken: "should-be-stripped", rowCount: 5, conversationId: "abc" },
    });

    const text = diag.toClipboardText();
    expect(text).not.toContain("should-be-stripped");
    expect(text).toContain("rowCount");
    expect(text).toContain("conversationId");
    expect(text).toContain("abc");
  });
});
