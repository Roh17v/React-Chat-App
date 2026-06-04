// @ts-check
/**
 * Unit tests for {@link runUnifiedIncremental} — the Telegram-style
 * single-endpoint incremental sync introduced to replace the N-call loop.
 *
 * Covers:
 *   1. DM messages (sent by local user) routed to correct conversationId
 *   2. DM messages (received by local user) routed to correct conversationId
 *   3. Channel messages routed to channelId as conversationId
 *   4. Mixed response: DMs + channels split into correct groups
 *   5. Empty response → returns ok:true, 0 messages, cursor still advanced
 *   6. Pagination: hasMore=true → advances since to syncedUpTo, fetches page 2
 *   7. Network error → returns ok:false without throwing
 *   8. setLastIncrementalSyncAt called after successful sync
 *   9. setLastIncrementalSyncAt called even when response is empty (caught up)
 *  10. Missing lastSyncAt throws immediately (argument validation)
 */

import { describe, it, expect, vi } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";
import { createPerConversationMutex } from "../utils/PerConversationMutex.js";
import { createRepository } from "../repositories/index.js";
import { runUnifiedIncremental } from "./incremental.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeRepository() {
  const driver = createTestSqliteDriver();
  const diagnostics = createDiagnostics({ maxEvents: 200 });
  const mutex = createPerConversationMutex();
  const migrator = createMigrator({ driver });
  const repository = createRepository({
    driver,
    migrator,
    diagnostics,
    mutex,
    filesystem: {
      rmdir: async () => undefined,
      mkdir: async () => undefined,
      stat: async () => { throw new Error("noop"); },
    },
  });
  const init = await repository.init({ userId: "user-self" });
  expect(init).toEqual({ ok: true });
  return { repository, driver, diagnostics };
}

/** Build the standard options object for runUnifiedIncremental */
function makeOptions(overrides = {}) {
  return {
    buildUrl: (p) => p,
    lastSyncAt: "2024-01-01T00:00:00.000Z",
    userId: "user-self",
    setLastIncrementalSyncAt: vi.fn(async () => {}),
    diagnostics: createDiagnostics({ maxEvents: 200 }),
    now: () => Date.now(),
    pageLimit: 500,
    ...overrides,
  };
}

/** Helper to build a raw server DM message */
function makeDmMessage(overrides = {}) {
  return {
    _id: `msg-${Math.random().toString(36).slice(2)}`,
    sender: { _id: "user-other" },
    receiver: "user-self",
    messageType: "text",
    content: "hello",
    status: "sent",
    createdAt: "2024-01-01T00:01:00.000Z",
    updatedAt: "2024-01-01T00:01:00.000Z",
    channelId: null,
    ...overrides,
  };
}

/** Helper to build a raw server channel message */
function makeChannelMessage(overrides = {}) {
  return {
    _id: `msg-${Math.random().toString(36).slice(2)}`,
    sender: { _id: "user-other" },
    receiver: null,
    messageType: "text",
    content: "channel hello",
    status: "sent",
    createdAt: "2024-01-01T00:01:00.000Z",
    updatedAt: "2024-01-01T00:01:00.000Z",
    channelId: "channel-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runUnifiedIncremental", () => {
  it("routes a DM received by local user to the sender as conversationId", async () => {
    const { repository, driver } = await makeRepository();

    const msg = makeDmMessage({
      _id: "dm-received",
      sender: { _id: "user-other" },
      receiver: "user-self",
    });

    const apiClient = {
      get: vi.fn(async () => ({
        data: {
          messages: [msg],
          hasMore: false,
          syncedUpTo: "2024-01-01T00:01:00.000Z",
        },
      })),
    };

    const result = await runUnifiedIncremental({
      ...makeOptions(),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBe(1);
    expect(result.batchesApplied).toBe(1); // one conversation group

    // Confirm message persisted under the SENDER's id (the peer)
    const rows = await driver.query(
      "SELECT server_id, conversation_id FROM messages WHERE server_id = ?",
      ["dm-received"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe("user-other");
  });

  it("routes a DM sent by local user to the receiver as conversationId", async () => {
    const { repository, driver } = await makeRepository();

    const msg = makeDmMessage({
      _id: "dm-sent",
      sender: { _id: "user-self" },
      receiver: "user-other",
    });

    const apiClient = {
      get: vi.fn(async () => ({
        data: {
          messages: [msg],
          hasMore: false,
          syncedUpTo: "2024-01-01T00:01:00.000Z",
        },
      })),
    };

    const result = await runUnifiedIncremental({
      ...makeOptions(),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBe(1);

    const rows = await driver.query(
      "SELECT server_id, conversation_id FROM messages WHERE server_id = ?",
      ["dm-sent"],
    );
    expect(rows).toHaveLength(1);
    // Conversation is keyed by the peer (receiver), not sender
    expect(rows[0].conversation_id).toBe("user-other");
  });

  it("routes channel messages to channelId as conversationId", async () => {
    const { repository, driver } = await makeRepository();

    const msg = makeChannelMessage({
      _id: "ch-msg",
      channelId: "channel-abc",
    });

    const apiClient = {
      get: vi.fn(async () => ({
        data: {
          messages: [msg],
          hasMore: false,
          syncedUpTo: "2024-01-01T00:01:00.000Z",
        },
      })),
    };

    const result = await runUnifiedIncremental({
      ...makeOptions(),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBe(1);

    const rows = await driver.query(
      "SELECT server_id, conversation_id FROM messages WHERE server_id = ?",
      ["ch-msg"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe("channel-abc");
  });

  it("handles a mixed response: DMs and channels split into correct groups", async () => {
    const { repository, driver } = await makeRepository();

    const dmMsg = makeDmMessage({
      _id: "mixed-dm",
      sender: { _id: "user-other" },
      receiver: "user-self",
    });
    const chMsg = makeChannelMessage({
      _id: "mixed-ch",
      channelId: "channel-xyz",
    });

    const apiClient = {
      get: vi.fn(async () => ({
        data: {
          messages: [dmMsg, chMsg],
          hasMore: false,
          syncedUpTo: "2024-01-01T00:02:00.000Z",
        },
      })),
    };

    const result = await runUnifiedIncremental({
      ...makeOptions(),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBe(2);
    expect(result.batchesApplied).toBe(2); // one batch per conversation

    // Both messages persisted in their correct conversations
    const dmRow = await driver.query(
      "SELECT conversation_id FROM messages WHERE server_id = 'mixed-dm'",
      [],
    );
    expect(dmRow[0].conversation_id).toBe("user-other");

    const chRow = await driver.query(
      "SELECT conversation_id FROM messages WHERE server_id = 'mixed-ch'",
      [],
    );
    expect(chRow[0].conversation_id).toBe("channel-xyz");
  });

  it("returns ok:true with 0 messages when the response is empty (already caught up)", async () => {
    const { repository } = await makeRepository();
    const setLastIncrementalSyncAt = vi.fn(async () => {});

    const apiClient = {
      get: vi.fn(async () => ({
        data: { messages: [], hasMore: false, syncedUpTo: "2024-01-01T00:00:00.000Z" },
      })),
    };

    const result = await runUnifiedIncremental({
      ...makeOptions({ setLastIncrementalSyncAt }),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBe(0);
    expect(result.batchesApplied).toBe(0);
    expect(result.pagesConsumed).toBe(1);
  });

  it("paginates: advances since to syncedUpTo when hasMore=true", async () => {
    const { repository } = await makeRepository();

    const page1Msg = makeDmMessage({ _id: "page1-msg" });
    const page2Msg = makeDmMessage({
      _id: "page2-msg",
      createdAt: "2024-01-01T00:02:00.000Z",
    });

    let callCount = 0;
    const apiClient = {
      get: vi.fn(async (_url, opts) => {
        callCount += 1;
        if (callCount === 1) {
          // First page — server says there's more
          expect(opts.params.since).toBe("2024-01-01T00:00:00.000Z");
          return {
            data: {
              messages: [page1Msg],
              hasMore: true,
              syncedUpTo: "2024-01-01T00:01:00.000Z",
            },
          };
        }
        // Second page — client must advance since to syncedUpTo from page 1
        expect(opts.params.since).toBe("2024-01-01T00:01:00.000Z");
        return {
          data: {
            messages: [page2Msg],
            hasMore: false,
            syncedUpTo: "2024-01-01T00:02:00.000Z",
          },
        };
      }),
    };

    const result = await runUnifiedIncremental({
      ...makeOptions(),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBe(2);
    expect(result.pagesConsumed).toBe(2);
    expect(callCount).toBe(2);
  });

  it("returns ok:false when the network call throws, without rethrowing", async () => {
    const { repository } = await makeRepository();

    const apiClient = {
      get: vi.fn(async () => {
        throw new Error("Network error");
      }),
    };

    // Must resolve (not reject)
    const result = await runUnifiedIncremental({
      ...makeOptions(),
      repository,
      apiClient,
    });

    expect(result.ok).toBe(false);
    expect(result.messagesApplied).toBe(0);
  });

  it("calls setLastIncrementalSyncAt after a successful sync", async () => {
    const { repository } = await makeRepository();
    const setLastIncrementalSyncAt = vi.fn(async () => {});

    const apiClient = {
      get: vi.fn(async () => ({
        data: {
          messages: [makeDmMessage({ _id: "cursor-test-msg" })],
          hasMore: false,
          syncedUpTo: "2024-01-01T00:05:00.000Z",
        },
      })),
    };

    await runUnifiedIncremental({
      ...makeOptions({ setLastIncrementalSyncAt }),
      repository,
      apiClient,
    });

    expect(setLastIncrementalSyncAt).toHaveBeenCalledOnce();
    // The timestamp passed should be a valid ISO string
    const [ts] = setLastIncrementalSyncAt.mock.calls[0];
    expect(new Date(ts).getTime()).not.toBeNaN();
  });

  it("calls setLastIncrementalSyncAt even when response is empty (cursor must advance)", async () => {
    const { repository } = await makeRepository();
    const setLastIncrementalSyncAt = vi.fn(async () => {});

    const apiClient = {
      get: vi.fn(async () => ({
        data: { messages: [], hasMore: false, syncedUpTo: "2024-01-01T00:00:00.000Z" },
      })),
    };

    await runUnifiedIncremental({
      ...makeOptions({ setLastIncrementalSyncAt }),
      repository,
      apiClient,
    });

    // Even with no messages, the cursor must be persisted so the next
    // app-open doesn't re-fetch the same empty window.
    expect(setLastIncrementalSyncAt).toHaveBeenCalledOnce();
  });

  it("throws synchronously when lastSyncAt is missing", async () => {
    const { repository } = await makeRepository();
    const apiClient = { get: vi.fn() };

    await expect(
      runUnifiedIncremental({
        ...makeOptions({ lastSyncAt: "" }),
        repository,
        apiClient,
      }),
    ).rejects.toThrow("lastSyncAt (ISO string) is required");
  });

  it("does not call the API more than pageCap times even if hasMore stays true", async () => {
    const { repository } = await makeRepository();

    // Server always returns hasMore:true — simulates a misbehaving backend
    const apiClient = {
      get: vi.fn(async () => ({
        data: {
          messages: [makeDmMessage()],
          hasMore: true,
          syncedUpTo: "2024-01-01T00:01:00.000Z",
        },
      })),
    };

    const PAGE_CAP = 3;
    const result = await runUnifiedIncremental({
      ...makeOptions({ incrementalPageCap: PAGE_CAP }),
      repository,
      apiClient,
    });

    // Must stop after pageCap pages regardless of hasMore
    expect(apiClient.get.mock.calls.length).toBe(PAGE_CAP);
    // Still resolves ok (we saved what we got)
    expect(result.ok).toBe(true);
    expect(result.pagesConsumed).toBe(PAGE_CAP);
  });
});
