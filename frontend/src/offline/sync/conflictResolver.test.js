// @ts-check
/**
 * Unit tests for the §3.6 conflict resolver (task 8.1).
 *
 * Drives `resolveAndApply` directly against the in-memory `better-sqlite3`
 * test driver, with the migrator providing the real `messages` schema. The
 * tests exercise each outcome path the resolver can return:
 *
 *   1. inserted   — no local row matches `server_id` or `client_temp_id`.
 *   2. merged     — optimistic local row gets its `server_id` for the first
 *                   time; local-only fields (`client_temp_id`, `queue_seq`,
 *                   `local_file_path`, `deleted_for_me`) are preserved.
 *   3. updated    — already-confirmed local row receives a fresh server
 *                   payload (e.g. status bump, deletion).
 *   4. ignored / STALE_PAYLOAD       — server payload's `updatedAt` is
 *                                       strictly older than a confirmed
 *                                       local row.
 *   5. ignored / STALE_RESURRECTION  — local row is `deleted_for_everyone`
 *                                       but the incoming payload claims
 *                                       otherwise without a strictly newer
 *                                       `updatedAt`.
 *   6. rejected — wire-format validator returns `MISSING_FIELD` for a
 *                 malformed server payload (Req 12.5).
 *
 * Validates: Requirements 9.1, 9.2, 9.3 (and the local-only preservation
 * clause), 7.5, 7.6 (status monotonicity through the resolver path).
 *
 * The tests bypass the repository and operate within an explicit
 * `withTransaction` so the resolver's contract — pure with respect to the
 * supplied `tx` — is exercised verbatim. We compare on snake_case columns
 * because the resolver writes raw SQL; the repository's row mapper is not
 * involved here.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import {
  __resetDiagnosticsSingletonForTests,
  createDiagnostics,
} from "../utils/Diagnostics.js";
import { resolveAndApply } from "./conflictResolver.js";

/**
 * Build a freshly migrated test driver and reset the diagnostics singleton
 * (the resolver delegates to it via `monotonicMaxStatus` on backwards-status
 * paths). Returns the driver so the caller can assert on raw rows.
 */
async function makeDriver() {
  __resetDiagnosticsSingletonForTests();
  const driver = createTestSqliteDriver();
  await driver.open();
  const diagnostics = createDiagnostics();
  const migrator = createMigrator({ diagnostics });
  const result = await migrator.applyPending(driver);
  expect(result.ok).toBe(true);
  return driver;
}

/**
 * Insert a `messages` row directly via SQL. Used to seed local state in
 * scenarios that pre-date a server payload (optimistic-send, prior delete,
 * confirmed-then-restale).
 *
 * @param {ReturnType<typeof createTestSqliteDriver>} driver
 * @param {Partial<Record<string, unknown>>} overrides
 */
async function insertLocal(driver, overrides) {
  const row = {
    id: "local-1",
    server_id: null,
    client_temp_id: null,
    conversation_id: "user-other",
    conversation_type: "dm",
    sender_id: "user-self",
    receiver_id: "user-other",
    channel_id: null,
    message_type: "text",
    content: "hi",
    file_url: null,
    file_name: null,
    file_metadata_json: "{}",
    reply_to_json: null,
    status: "pending",
    deleted_for_everyone: 0,
    deleted_for_me: 0,
    deleted_at: null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    sync_state: "local_only",
    queue_seq: null,
    local_file_path: null,
    ...overrides,
  };
  await driver.run(
    `INSERT INTO messages (
       id, server_id, client_temp_id, conversation_id, conversation_type,
       sender_id, receiver_id, channel_id, message_type, content,
       file_url, file_name, file_metadata_json, reply_to_json, status,
       deleted_for_everyone, deleted_for_me, deleted_at, created_at,
       updated_at, sync_state, queue_seq, local_file_path
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.server_id,
      row.client_temp_id,
      row.conversation_id,
      row.conversation_type,
      row.sender_id,
      row.receiver_id,
      row.channel_id,
      row.message_type,
      row.content,
      row.file_url,
      row.file_name,
      row.file_metadata_json,
      row.reply_to_json,
      row.status,
      row.deleted_for_everyone,
      row.deleted_for_me,
      row.deleted_at,
      row.created_at,
      row.updated_at,
      row.sync_state,
      row.queue_seq,
      row.local_file_path,
    ],
  );
}

/**
 * Build a minimal-but-complete server message payload that satisfies the
 * wire-format validator's required fields.
 *
 * @param {Partial<Record<string, unknown>>} overrides
 */
function makeServerMessage(overrides = {}) {
  return {
    _id: "srv-1",
    sender: "user-other",
    receiver: "user-self",
    messageType: "text",
    content: "hello",
    fileUrl: null,
    fileName: null,
    fileMetadata: {},
    replyTo: null,
    status: "sent",
    channelId: null,
    deletedForEveryone: false,
    deletedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    clientTempId: null,
    ...overrides,
  };
}

/**
 * Drive a single `resolveAndApply` call wrapped in a transaction (the
 * resolver's caller contract). Returns the resolver's outcome plus the
 * full row state observed AFTER the transaction commits.
 *
 * @param {ReturnType<typeof createTestSqliteDriver>} driver
 * @param {unknown} serverMessage
 * @param {Partial<{ conversationId: string, conversationType: "dm"|"channel", uuid: () => string }>} [ctx]
 */
async function applyOne(driver, serverMessage, ctx) {
  /** @type {import("./conflictResolver.js").ResolveOutcome} */
  let outcome;
  await driver.withTransaction(async (tx) => {
    outcome = await resolveAndApply(tx, serverMessage, {
      conversationId: ctx?.conversationId || "user-other",
      conversationType: ctx?.conversationType || "dm",
      uuid: ctx?.uuid,
    });
  });
  return /** @type {import("./conflictResolver.js").ResolveOutcome} */ (outcome);
}

describe("resolveAndApply", () => {
  /** @type {ReturnType<typeof createTestSqliteDriver>} */
  let driver;

  beforeEach(async () => {
    driver = await makeDriver();
  });

  describe("outcome: inserted", () => {
    it("inserts a brand-new row with sync_state='confirmed' and a generated id", async () => {
      const result = await applyOne(
        driver,
        makeServerMessage({ _id: "srv-new", content: "fresh" }),
        { uuid: () => "generated-uuid" },
      );

      expect(result.outcome).toBe("inserted");
      if (result.outcome !== "inserted") return;
      expect(result.id).toBe("generated-uuid");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages")
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("generated-uuid");
      expect(rows[0].server_id).toBe("srv-new");
      expect(rows[0].client_temp_id).toBeNull();
      expect(rows[0].conversation_id).toBe("user-other");
      expect(rows[0].conversation_type).toBe("dm");
      expect(rows[0].sender_id).toBe("user-other");
      expect(rows[0].receiver_id).toBe("user-self");
      expect(rows[0].content).toBe("fresh");
      expect(rows[0].sync_state).toBe("confirmed");
      expect(rows[0].queue_seq).toBeNull();
      expect(rows[0].local_file_path).toBeNull();
    });
  });

  describe("outcome: merged", () => {
    it("merges an optimistic local row with its server confirmation by client_temp_id", async () => {
      // Seed an optimistic local row sitting in the outbound queue. The
      // resolver should match on `client_temp_id` and
      // assign the server_id without losing the local-only metadata.
      await insertLocal(driver, {
        id: "local-merge",
        client_temp_id: "tmp-abc",
        status: "pending",
        sync_state: "local_only",
        queue_seq: 42,
        local_file_path: "/files/outbound/foo.png",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-merged",
          sender: "user-self",
          receiver: "user-other",
          status: "sent",
          clientTempId: "tmp-abc",
          createdAt: "2024-01-01T00:00:01.000Z",
          updatedAt: "2024-01-01T00:00:01.000Z",
        }),
      );

      expect(result.outcome).toBe("merged");
      if (result.outcome !== "merged") return;
      expect(result.id).toBe("local-merge");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages")
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("local-merge");
      expect(rows[0].server_id).toBe("srv-merged");
      expect(rows[0].status).toBe("sent");
      expect(rows[0].sync_state).toBe("confirmed");
      // Local-only fields are preserved verbatim across the merge.
      expect(rows[0].client_temp_id).toBe("tmp-abc");
      expect(rows[0].queue_seq).toBe(42);
      expect(rows[0].local_file_path).toBe("/files/outbound/foo.png");
    });
  });

  describe("outcome: updated", () => {
    it("overwrites a confirmed row with a strictly-newer payload and reconciles status forward", async () => {
      await insertLocal(driver, {
        id: "local-confirmed",
        server_id: "srv-x",
        client_temp_id: null,
        status: "delivered",
        sync_state: "confirmed",
        queue_seq: null,
        local_file_path: null,
        content: "old",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-x",
          content: "new",
          status: "read",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
        }),
      );

      expect(result.outcome).toBe("updated");
      if (result.outcome !== "updated") return;
      expect(result.id).toBe("local-confirmed");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages WHERE id = 'local-confirmed'")
      );
      expect(rows[0].content).toBe("new");
      expect(rows[0].status).toBe("read");
      expect(rows[0].updated_at).toBe("2024-01-02T00:00:00.000Z");
      expect(rows[0].sync_state).toBe("confirmed");
    });

    it("never moves status backwards via monotonicMaxStatus even when the server says so", async () => {
      // A confirmed `read` row receives a `delivered` payload with a newer
      // `updated_at`. The resolver still wins (server payload is fresher),
      // but the status must stay `read` because backwards-status moves are
      // dropped (Req 7.5, 7.6).
      await insertLocal(driver, {
        id: "local-read",
        server_id: "srv-r",
        status: "read",
        sync_state: "confirmed",
        content: "old",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-r",
          content: "newer",
          status: "delivered",
          updatedAt: "2024-01-02T00:00:00.000Z",
        }),
      );

      expect(result.outcome).toBe("updated");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages WHERE id = 'local-read'")
      );
      expect(rows[0].status).toBe("read");
      expect(rows[0].content).toBe("newer");
    });
  });

  describe("outcome: ignored", () => {
    it("ignores a stale server payload whose updated_at is strictly older than the confirmed local row", async () => {
      await insertLocal(driver, {
        id: "local-fresh",
        server_id: "srv-s",
        status: "delivered",
        sync_state: "confirmed",
        content: "fresh-local",
        created_at: "2024-01-02T00:00:00.000Z",
        updated_at: "2024-01-02T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-s",
          content: "stale-server",
          status: "delivered",
          createdAt: "2024-01-02T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      );

      expect(result.outcome).toBe("ignored");
      if (result.outcome !== "ignored") return;
      expect(result.reason).toBe("STALE_PAYLOAD");
      expect(result.id).toBe("local-fresh");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages WHERE id = 'local-fresh'")
      );
      expect(rows[0].content).toBe("fresh-local");
      expect(rows[0].updated_at).toBe("2024-01-02T00:00:00.000Z");
    });

    it("ignores a stale-resurrection payload (deleted local, server claims undeleted, updatedAt not strictly newer)", async () => {
      await insertLocal(driver, {
        id: "local-deleted",
        server_id: "srv-d",
        status: "sent",
        sync_state: "confirmed",
        deleted_for_everyone: 1,
        content: null,
        file_url: null,
        file_name: null,
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-02T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-d",
          content: "back from the dead",
          deletedForEveryone: false,
          createdAt: "2024-01-01T00:00:00.000Z",
          // Equal updated_at — the resurrection guard demands STRICTLY newer.
          updatedAt: "2024-01-02T00:00:00.000Z",
        }),
      );

      expect(result.outcome).toBe("ignored");
      if (result.outcome !== "ignored") return;
      expect(result.reason).toBe("STALE_RESURRECTION");
      expect(result.id).toBe("local-deleted");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages WHERE id = 'local-deleted'")
      );
      expect(rows[0].deleted_for_everyone).toBe(1);
      expect(rows[0].content).toBeNull();
    });

    it("accepts a resurrection payload when updatedAt is strictly newer", async () => {
      // Companion to the previous test: when the server can prove the
      // payload is newer than the deletion, the row is restored.
      await insertLocal(driver, {
        id: "local-deleted-2",
        server_id: "srv-d2",
        status: "sent",
        sync_state: "confirmed",
        deleted_for_everyone: 1,
        content: null,
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-02T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-d2",
          content: "restored",
          deletedForEveryone: false,
          updatedAt: "2024-01-03T00:00:00.000Z",
        }),
      );

      expect(result.outcome).toBe("updated");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages WHERE id = 'local-deleted-2'")
      );
      expect(rows[0].deleted_for_everyone).toBe(0);
      expect(rows[0].content).toBe("restored");
    });

    it("accepts a stale server payload when the local row is still optimistic (sync_state='local_only')", async () => {
      // Req 9.3: pending/local_only rows always accept the server payload
      // so optimistic-send confirmations land regardless of clock skew.
      await insertLocal(driver, {
        id: "local-optimistic",
        client_temp_id: "tmp-opt",
        status: "pending",
        sync_state: "local_only",
        queue_seq: 7,
        created_at: "2024-01-02T00:00:00.000Z",
        updated_at: "2024-01-02T00:00:00.000Z",
      });

      const result = await applyOne(
        driver,
        makeServerMessage({
          _id: "srv-opt",
          status: "sent",
          clientTempId: "tmp-opt",
          // Older updatedAt than the local row would normally trigger
          // STALE_PAYLOAD, but sync_state='local_only' overrides that.
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      );

      expect(result.outcome).toBe("merged");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT * FROM messages WHERE id = 'local-optimistic'")
      );
      expect(rows[0].server_id).toBe("srv-opt");
      expect(rows[0].sync_state).toBe("confirmed");
      // Local-only fields preserved (Req 9.2).
      expect(rows[0].client_temp_id).toBe("tmp-opt");
      expect(rows[0].queue_seq).toBe(7);
    });
  });

  describe("outcome: rejected", () => {
    it("rejects a payload missing a required field with a typed MISSING_FIELD error", async () => {
      // Drop `_id` — the wire-format validator returns MISSING_FIELD which
      // the resolver propagates as a `rejected` outcome (not a throw).
      const result = await applyOne(driver, {
        sender: "user-other",
        receiver: "user-self",
        messageType: "text",
        content: "broken",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      });

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.error.kind).toBe("MISSING_FIELD");
      expect(result.error.field).toBe("_id");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT COUNT(*) AS n FROM messages")
      );
      expect(Number(rows[0].n)).toBe(0);
    });

    it("rejects an invalid context (missing conversationId) before touching the DB", async () => {
      let outcome;
      await driver.withTransaction(async (tx) => {
        outcome = await resolveAndApply(
          tx,
          makeServerMessage({ _id: "srv-rej" }),
          // @ts-expect-error — intentionally invalid context for the test.
          { conversationId: "", conversationType: "dm" },
        );
      });

      expect(outcome.outcome).toBe("rejected");
      expect(outcome.error.kind).toBe("INVALID_CONTEXT");

      const rows = /** @type {Record<string, unknown>[]} */ (
        await driver.query("SELECT COUNT(*) AS n FROM messages")
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});
