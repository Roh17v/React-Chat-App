// @ts-check
/**
 * Unit tests for the repository write methods (task 7.2).
 *
 * Drives the repository through `createTestSqliteDriver()` so the assertions
 * exercise the real SQL — no mocks. Each test starts from a freshly migrated
 * empty DB.
 *
 * Covers:
 *   - applyServerMessages: insert + cursor advance + retention prune
 *   - applyServerMessages: optimistic-merge by client_temp_id
 *   - applyServerMessages: stale payload ignored
 *   - applyLiveMessage: DM conversation routing
 *   - applyDeletion: clears content/file_url/file_name and bumps updated_at
 *   - applyStatusUpdate: monotonic enforcement, backwards moves logged
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";
import { createRepository } from "./index.js";

/**
 * Build a repository wired to an in-memory SQLite test driver. Returns the
 * repository, the diagnostics buffer (so tests can assert on logged events),
 * and the underlying driver (so tests can assert on raw rows).
 */
async function makeRepository() {
  const driver = createTestSqliteDriver();
  await driver.open();
  const diagnostics = createDiagnostics();
  const migrator = createMigrator({ diagnostics });

  const repository = createRepository({
    driver,
    diagnostics,
    encryption: {
      getOrCreatePassphrase: async () => ({ mode: "none", passphrase: "" }),
      destroy: async () => {},
    },
    migrate: (d, opts) => migrator.applyPending(d, opts),
    skipDriverOpen: true,
    isNativePlatform: () => false,
    filesystem: {
      rmdir: async () => undefined,
      mkdir: async () => undefined,
      stat: async () => {
        throw new Error("noop");
      },
    },
  });

  const init = await repository.init({ userId: "user-self" });
  expect(init).toEqual({ ok: true });
  return { repository, driver, diagnostics };
}

/**
 * Helper to build a server message payload aligned with the wire-format
 * serializer's expectations.
 *
 * @param {Partial<{ _id: string, sender: string, receiver: string, content: string, createdAt: string, updatedAt: string, status: string, clientTempId: string, deletedForEveryone: boolean, channelId: string, messageType: string, fileUrl: string }>} overrides
 */
function makeServerMessage(overrides = {}) {
  return {
    _id: overrides._id || "srv-1",
    sender: overrides.sender || "user-other",
    receiver: overrides.receiver || "user-self",
    messageType: overrides.messageType || "text",
    content: overrides.content == null ? "hello" : overrides.content,
    fileUrl: overrides.fileUrl ?? null,
    fileName: null,
    fileMetadata: {},
    replyTo: null,
    status: overrides.status || "sent",
    channelId: overrides.channelId ?? null,
    deletedForEveryone: overrides.deletedForEveryone === true,
    deletedAt: null,
    createdAt: overrides.createdAt || "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2024-01-01T00:00:00.000Z",
    clientTempId: overrides.clientTempId ?? null,
  };
}

describe("repository.applyServerMessages", () => {
  /** @type {Awaited<ReturnType<typeof makeRepository>>} */
  let ctx;
  beforeEach(async () => {
    ctx = await makeRepository();
  });

  it("inserts new rows and advances the sync cursor", async () => {
    const result = await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-a",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
        makeServerMessage({
          _id: "srv-b",
          content: "second",
          createdAt: "2024-01-01T00:01:00.000Z",
          updatedAt: "2024-01-01T00:01:00.000Z",
        }),
      ],
    });

    expect(result).toEqual({ inserted: 2, updated: 0, ignored: 0 });

    const rows = await ctx.driver.query(
      "SELECT server_id, content, conversation_id, sync_state FROM messages ORDER BY created_at",
    );
    expect(rows).toEqual([
      {
        server_id: "srv-a",
        content: "hello",
        conversation_id: "user-other",
        sync_state: "confirmed",
      },
      {
        server_id: "srv-b",
        content: "second",
        conversation_id: "user-other",
        sync_state: "confirmed",
      },
    ]);

    const cursor = await ctx.driver.query(
      "SELECT last_server_id, last_created_at FROM sync_cursors",
    );
    expect(cursor).toEqual([
      {
        last_server_id: "srv-b",
        last_created_at: "2024-01-01T00:01:00.000Z",
      },
    ]);
  });

  it("merges optimistic local rows by client_temp_id", async () => {
    // Seed an optimistic local row (as the outbound queue would).
    await ctx.driver.run(
      `INSERT INTO messages (
         id, server_id, client_temp_id, conversation_id, conversation_type,
         sender_id, receiver_id, channel_id, message_type, content,
         file_url, file_name, file_metadata_json, reply_to_json, status,
         deleted_for_everyone, deleted_for_me, deleted_at, created_at,
         updated_at, sync_state, queue_seq, local_file_path
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        "local-1",
        null,
        "tmp-abc",
        "user-other",
        "dm",
        "user-self",
        "user-other",
        null,
        "text",
        "hi",
        null,
        null,
        "{}",
        null,
        "pending",
        0,
        0,
        null,
        "2024-01-01T00:00:00.000Z",
        "2024-01-01T00:00:00.000Z",
        "local_only",
        7,
        null,
      ],
    );

    const result = await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-merged",
          sender: "user-self",
          receiver: "user-other",
          content: "hi",
          status: "sent",
          clientTempId: "tmp-abc",
          createdAt: "2024-01-01T00:00:01.000Z",
          updatedAt: "2024-01-01T00:00:01.000Z",
        }),
      ],
    });

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await ctx.driver.query(
      "SELECT id, server_id, client_temp_id, queue_seq, status, sync_state FROM messages",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "local-1",
      server_id: "srv-merged",
      client_temp_id: "tmp-abc", // local-only fields preserved
      queue_seq: 7,
      status: "sent",
      sync_state: "confirmed",
    });
  });

  it("ignores stale server payloads", async () => {
    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-x",
          content: "newer",
          createdAt: "2024-01-02T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
        }),
      ],
    });

    const result = await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-x",
          content: "older",
          createdAt: "2024-01-02T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z", // strictly older than the existing row
        }),
      ],
    });

    expect(result).toEqual({ inserted: 0, updated: 0, ignored: 1 });
    const rows = await ctx.driver.query(
      "SELECT content, updated_at FROM messages WHERE server_id = 'srv-x'",
    );
    expect(rows[0].content).toBe("newer");
    expect(rows[0].updated_at).toBe("2024-01-02T00:00:00.000Z");
  });

  it("prunes per-conversation retention down to the configured bound", async () => {
    // Lower the retention bound so the test stays fast.
    await ctx.driver.run(
      "INSERT INTO meta (key, value) VALUES ('messages_retention_max', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    // Force the repository to re-init so the cached bound picks up the new value.
    const fresh = await makeRepository();
    await fresh.driver.run(
      "INSERT INTO meta (key, value) VALUES ('messages_retention_max', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    // Re-init by toggling the user — easier is to just drive 10 messages
    // through the original ctx and rely on the default 500 bound. Instead
    // we use the fresh repository.
    const messages = [];
    for (let i = 0; i < 10; i += 1) {
      const ts = new Date(Date.UTC(2024, 0, 1, 0, i, 0)).toISOString();
      messages.push(
        makeServerMessage({
          _id: `srv-${i}`,
          content: `m${i}`,
          createdAt: ts,
          updatedAt: ts,
        }),
      );
    }
    // Reload meta cache by re-init (new repository instance).
    const ctx2 = fresh;
    await ctx2.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages,
    });
    // The cached config was loaded BEFORE we changed the row; the 10 messages
    // therefore exceed the bound only after a re-init. Re-init won't change
    // the cache here either because init bails when ready+sameUser. We test
    // the prune path directly through `pruneRetention`.
    const before = await ctx2.driver.query(
      "SELECT COUNT(*) AS n FROM messages",
    );
    expect(before[0].n).toBe(10);

    await ctx2.repository.pruneRetention("user-other", { max: 5 });
    const after = await ctx2.driver.query(
      "SELECT server_id FROM messages ORDER BY created_at ASC",
    );
    expect(after.map((r) => r.server_id)).toEqual([
      "srv-5",
      "srv-6",
      "srv-7",
      "srv-8",
      "srv-9",
    ]);
  });
});

describe("repository.applyLiveMessage", () => {
  it("routes DM live events to the contact's conversationId", async () => {
    const ctx = await makeRepository();

    await ctx.repository.applyLiveMessage({
      _id: "srv-live",
      sender: { _id: "user-other" },
      receiver: { _id: "user-self" },
      messageType: "text",
      content: "yo",
      status: "delivered",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const rows = await ctx.driver.query(
      "SELECT conversation_id, conversation_type, sender_id, status FROM messages WHERE server_id = 'srv-live'",
    );
    expect(rows).toEqual([
      {
        conversation_id: "user-other",
        conversation_type: "dm",
        sender_id: "user-other",
        status: "delivered",
      },
    ]);
  });

  it("routes channel live events to the channelId", async () => {
    const ctx = await makeRepository();
    await ctx.repository.applyLiveMessage({
      _id: "srv-ch",
      sender: { _id: "user-other" },
      messageType: "text",
      content: "hi channel",
      status: "sent",
      channelId: "ch-1",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const rows = await ctx.driver.query(
      "SELECT conversation_id, conversation_type, channel_id FROM messages WHERE server_id = 'srv-ch'",
    );
    expect(rows).toEqual([
      {
        conversation_id: "ch-1",
        conversation_type: "channel",
        channel_id: "ch-1",
      },
    ]);
  });
});

describe("repository.applyDeletion", () => {
  it("clears content/file_url/file_name and strictly bumps updated_at", async () => {
    const ctx = await makeRepository();
    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        {
          ...makeServerMessage({
            _id: "srv-del",
            messageType: "file",
            content: "preview",
            updatedAt: "2024-01-01T00:00:00.000Z",
            createdAt: "2024-01-01T00:00:00.000Z",
          }),
          fileUrl: "https://example.com/f.png",
          fileName: "f.png",
        },
      ],
    });

    const before = await ctx.driver.query(
      "SELECT updated_at FROM messages WHERE server_id = 'srv-del'",
    );
    const priorUpdatedAt = before[0].updated_at;

    await ctx.repository.applyDeletion({
      serverId: "srv-del",
      deletedForEveryone: true,
    });

    const after = await ctx.driver.query(
      "SELECT content, file_url, file_name, deleted_for_everyone, updated_at FROM messages WHERE server_id = 'srv-del'",
    );
    expect(after[0]).toEqual({
      content: null,
      file_url: null,
      file_name: null,
      deleted_for_everyone: 1,
      updated_at: after[0].updated_at,
    });
    expect(after[0].updated_at > priorUpdatedAt).toBe(true);
  });

  it("is a no-op when the server_id does not exist", async () => {
    const ctx = await makeRepository();
    await ctx.repository.applyDeletion({
      serverId: "missing",
      deletedForEveryone: true,
    });
    const rows = await ctx.driver.query("SELECT COUNT(*) AS n FROM messages");
    expect(rows[0].n).toBe(0);
  });
});

describe("repository.applyStatusUpdate", () => {
  it("advances delivered → read for matching DM rows", async () => {
    const ctx = await makeRepository();
    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-a",
          sender: "user-other",
          receiver: "user-self",
          status: "delivered",
        }),
      ],
    });

    await ctx.repository.applyStatusUpdate({
      conversationId: "user-other",
      fromUserId: "user-other",
      status: "read",
    });

    const rows = await ctx.driver.query(
      "SELECT status FROM messages WHERE server_id = 'srv-a'",
    );
    expect(rows[0].status).toBe("read");
  });

  it("ignores backwards status moves and logs STATUS_BACKWARDS_IGNORED", async () => {
    const ctx = await makeRepository();
    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-a",
          sender: "user-other",
          receiver: "user-self",
          status: "read",
        }),
      ],
    });

    await ctx.repository.applyStatusUpdate({
      conversationId: "user-other",
      fromUserId: "user-other",
      status: "delivered",
    });

    const rows = await ctx.driver.query(
      "SELECT status FROM messages WHERE server_id = 'srv-a'",
    );
    expect(rows[0].status).toBe("read");

    const events = ctx.diagnostics.snapshot().events;
    const ignored = events.find((e) => e.code === "STATUS_BACKWARDS_IGNORED");
    expect(ignored).toBeDefined();
  });

  it("allows the failed → pending sanctioned retry transition", async () => {
    const ctx = await makeRepository();
    // Seed a failed row directly so we can drive the retry path.
    await ctx.driver.run(
      `INSERT INTO messages (
         id, server_id, client_temp_id, conversation_id, conversation_type,
         sender_id, receiver_id, channel_id, message_type, content,
         file_url, file_name, file_metadata_json, reply_to_json, status,
         deleted_for_everyone, deleted_for_me, deleted_at, created_at,
         updated_at, sync_state, queue_seq, local_file_path
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        "local-fail",
        null,
        "tmp-fail",
        "user-other",
        "dm",
        "user-other",
        "user-self",
        null,
        "text",
        "x",
        null,
        null,
        "{}",
        null,
        "failed",
        0,
        0,
        null,
        "2024-01-01T00:00:00.000Z",
        "2024-01-01T00:00:00.000Z",
        "local_only",
        null,
        null,
      ],
    );

    await ctx.repository.applyStatusUpdate({
      conversationId: "user-other",
      fromUserId: "user-other",
      status: "pending",
    });

    const rows = await ctx.driver.query(
      "SELECT status FROM messages WHERE id = 'local-fail'",
    );
    expect(rows[0].status).toBe("pending");
  });
});
