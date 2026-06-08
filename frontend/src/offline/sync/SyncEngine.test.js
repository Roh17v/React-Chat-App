// @ts-check
/**
 * Unit tests for {@link createSyncEngine} (task 11.1).
 *
 * Covers:
 *   - Bootstrap fetches contacts, channels, and per-conversation message
 *     pages; persists via repository.applyServerMessages.
 *   - Bootstrap marks a conversation `partial` after 3 retries and
 *     continues with the rest of the conversations.
 *   - Incremental sync uses the `since` cursor and pages until a short
 *     page comes back.
 *   - applyLiveEvent dispatches all five §3.3 socket events to the right
 *     repository call (and resolves / rejects the clientTempId
 *     deferred for `receiveMessage` / `messageSendFailed`).
 *   - Single-in-flight per conversation: two concurrent
 *     `incrementalConversation` calls for the same id share the same
 *     promise (Req 5.7).
 *
 * Drives the repository through `createTestSqliteDriver()` plus the
 * production `createRepository` so the SQL paths (sync_cursors,
 * applyServerMessages) execute end-to-end. The HTTP and tempIdRegistry
 * dependencies are stubbed.
 */

import { describe, it, expect, vi } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";
import { createPerConversationMutex } from "../utils/PerConversationMutex.js";
import { createRepository } from "../repositories/index.js";
import { createClientTempIdRegistry } from "./clientTempIdRegistry.js";
import { createSyncEngine } from "./SyncEngine.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a repository wired to an in-memory SQLite test driver. Mirrors the
 * helper used by `OutboundQueue.test.js` so the SQL layer is real.
 */
async function makeRepository() {
  const driver = createTestSqliteDriver();
  await driver.open();
  const diagnostics = createDiagnostics();
  const migrator = createMigrator({ diagnostics });
  const mutex = createPerConversationMutex();

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
    mutex,
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
 * Build a stub apiClient with route-aware response handlers. The stubbed
 * `get(url, opts)` records every call and returns the configured response
 * for the matching route key. Routes are matched by checking whether the
 * URL ends with the registered suffix — keeps the tests independent of
 * the `HOST` constant value.
 *
 * @param {Record<string, (params: Record<string, unknown> | undefined, url: string, callIndex: number) => Promise<unknown> | unknown>} routes
 */
function makeApiClient(routes) {
  /** @type {{ url: string, params: Record<string, unknown> | undefined }[]} */
  const calls = [];
  /** @type {Map<string, number>} */
  const callIndexByRoute = new Map();
  const get = vi.fn(async (url, opts) => {
    const params = opts != null ? opts.params : undefined;
    calls.push({ url, params });
    /** @type {string | null} */
    let matchedKey = null;
    for (const key of Object.keys(routes)) {
      if (url.endsWith(key) || url.includes(`${key}?`) || url.includes(`${key}/`)) {
        matchedKey = key;
        break;
      }
    }
    if (matchedKey == null) {
      throw Object.assign(new Error(`apiClient stub: no route for ${url}`), {
        code: "NO_STUB_ROUTE",
        url,
      });
    }
    const idx = (callIndexByRoute.get(matchedKey) || 0) + 1;
    callIndexByRoute.set(matchedKey, idx);
    const data = await routes[matchedKey](params, url, idx);
    return { data };
  });
  return { get, calls };
}

/** @returns {Record<string, unknown>} */
function makeServerMessage(overrides) {
  return {
    _id: "srv-default",
    sender: { _id: "user-other" },
    receiver: { _id: "user-self" },
    messageType: "text",
    content: "hello",
    status: "sent",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bootstrap()
// ---------------------------------------------------------------------------

describe("SyncEngine.bootstrap", () => {
  it("fetches DM contacts, channels, and per-conversation pages", async () => {
    const { repository, driver } = await makeRepository();

    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [
        { _id: "contact-1" },
        { _id: "contact-2" },
      ],
      "/api/channels": async () => [{ _id: "channel-1" }],
      "/api/messages/private/contact-1": async () => [
        makeServerMessage({
          _id: "srv-c1-a",
          sender: { _id: "contact-1" },
          createdAt: "2024-01-01T00:00:01.000Z",
          updatedAt: "2024-01-01T00:00:01.000Z",
        }),
        makeServerMessage({
          _id: "srv-c1-b",
          sender: { _id: "contact-1" },
          createdAt: "2024-01-01T00:00:00.500Z",
          updatedAt: "2024-01-01T00:00:00.500Z",
        }),
      ],
      "/api/messages/private/contact-2": async () => [],
      "/api/messages/channel/channel-1": async () => [
        makeServerMessage({
          _id: "srv-ch1-a",
          channelId: "channel-1",
          receiver: null,
          createdAt: "2024-01-01T00:00:02.000Z",
          updatedAt: "2024-01-01T00:00:02.000Z",
        }),
      ],
    });

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });

    const result = await engine.bootstrap();
    expect(result.ok).toBe(true);
    expect(result.conversationsTotal).toBe(3);
    expect(result.conversationsOk).toBe(3);
    expect(result.conversationsPartial).toBe(0);
    expect(engine.getStatus().bootstrapStatus).toBe("ok");

    // Verify the routes were called in the documented order.
    const urls = apiClient.calls.map((c) => c.url);
    expect(urls.filter((u) => u.endsWith("/api/users/dm-contacts"))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith("/api/channels"))).toHaveLength(1);
    expect(
      urls.filter((u) => u.endsWith("/api/messages/private/contact-1")),
    ).toHaveLength(1);
    expect(
      urls.filter((u) => u.endsWith("/api/messages/private/contact-2")),
    ).toHaveLength(1);
    expect(
      urls.filter((u) => u.endsWith("/api/messages/channel/channel-1")),
    ).toHaveLength(1);

    // Bootstrap must not pass `since` — it asks for the most recent page.
    const messageCalls = apiClient.calls.filter((c) =>
      c.url.includes("/api/messages/"),
    );
    for (const call of messageCalls) {
      expect(call.params).toBeDefined();
      expect(call.params?.since).toBeUndefined();
      expect(call.params?.limit).toBeDefined();
    }

    // Messages persisted.
    /** @type {any[]} */
    const messageRows = await driver.query(
      "SELECT server_id, conversation_id, conversation_type FROM messages " +
        "ORDER BY conversation_id, server_id",
    );
    const ids = messageRows.map((r) => r.server_id);
    expect(ids).toContain("srv-c1-a");
    expect(ids).toContain("srv-c1-b");
    expect(ids).toContain("srv-ch1-a");

    // Cursors advanced for conversations that received messages.
    /** @type {any[]} */
    const cursors = await driver.query(
      "SELECT conversation_id, last_server_id, last_updated_at FROM sync_cursors " +
        "ORDER BY conversation_id",
    );
    const c1 = cursors.find((r) => r.conversation_id === "contact-1");
    const ch1 = cursors.find((r) => r.conversation_id === "channel-1");
    expect(c1).toBeDefined();
    expect(c1?.last_server_id).toBe("srv-c1-a"); // newer updatedAt wins
    expect(c1?.last_updated_at).toBe("2024-01-01T00:00:01.000Z");
    expect(ch1?.last_server_id).toBe("srv-ch1-a");
  });

  it("retries up to 3 times then marks a conversation partial without blocking others", async () => {
    const { repository, driver } = await makeRepository();

    let contact1Calls = 0;
    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [
        { _id: "contact-1" },
        { _id: "contact-2" },
      ],
      "/api/channels": async () => [],
      "/api/messages/private/contact-1": async () => {
        contact1Calls += 1;
        throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      },
      "/api/messages/private/contact-2": async () => [
        makeServerMessage({
          _id: "srv-c2",
          sender: { _id: "contact-2" },
          createdAt: "2024-01-01T00:00:05.000Z",
          updatedAt: "2024-01-01T00:00:05.000Z",
        }),
      ],
    });

    const sleep = vi.fn(async () => {});
    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep,
      // Deterministic: zero jitter so the assertions on the retry budget
      // are stable.
      random: () => 0.5,
    });

    const result = await engine.bootstrap();
    expect(result.ok).toBe(true);
    expect(result.conversationsTotal).toBe(2);
    expect(result.conversationsOk).toBe(1);
    expect(result.conversationsPartial).toBe(1);
    expect(result.partialConversationIds).toEqual(["contact-1"]);
    expect(engine.getStatus().bootstrapStatus).toBe("partial");
    // Phase moves to ready even when some conversations are partial
    // (Req 4.6).
    expect(engine.getStatus().phase).toBe("ready");

    // 1 initial attempt + 3 retries = 4 total attempts on the failing
    // conversation (Req 4.5).
    expect(contact1Calls).toBe(4);
    // Three sleeps between the four attempts.
    expect(sleep).toHaveBeenCalledTimes(3);

    // The other conversation still landed.
    /** @type {any[]} */
    const rows = await driver.query(
      "SELECT server_id FROM messages WHERE conversation_id = ?",
      ["contact-2"],
    );
    expect(rows.map((r) => r.server_id)).toEqual(["srv-c2"]);
  });
});

// ---------------------------------------------------------------------------
// incremental()
// ---------------------------------------------------------------------------

describe("SyncEngine.incremental", () => {
  it("uses the since cursor and pages until a short page comes back", async () => {
    const { repository, driver } = await makeRepository();

    // Seed a baseline so a cursor exists for `contact-1`.
    await repository.applyServerMessages({
      conversationId: "contact-1",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-base",
          sender: { _id: "contact-1" },
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      ],
    });

    /** @type {Array<{ since: string | undefined, limit: number | undefined }>} */
    const recordedCalls = [];

    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [{ _id: "contact-1" }],
      "/api/channels": async () => [],
      "/api/messages/private/contact-1": async (params) => {
        recordedCalls.push({
          since: params != null ? /** @type {string | undefined} */ (params.since) : undefined,
          limit: params != null ? /** @type {number | undefined} */ (params.limit) : undefined,
        });
        // First call: full page (== limit) so the engine pages.
        // Second call: short page (< limit) so the engine stops.
        if (recordedCalls.length === 1) {
          /** @type {unknown[]} */
          const page = [];
          for (let i = 1; i <= 3; i += 1) {
            page.push(
              makeServerMessage({
                _id: `srv-page1-${i}`,
                sender: { _id: "contact-1" },
                createdAt: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
                updatedAt: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
              }),
            );
          }
          return page;
        }
        return [
          makeServerMessage({
            _id: "srv-page2-1",
            sender: { _id: "contact-1" },
            createdAt: "2024-01-01T00:00:10.000Z",
            updatedAt: "2024-01-01T00:00:10.000Z",
          }),
        ];
      },
    });

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      pageLimit: 3, // small cap so the first page is "full" with 3 rows
      sleep: async () => {},
    });

    const result = await engine.incremental();
    expect(result.ok).toBe(true);
    expect(result.conversationsScanned).toBe(1);
    expect(result.batchesApplied).toBe(2);
    expect(result.messagesApplied).toBe(4);
    expect(result.failedConversationIds).toEqual([]);

    // First page: cursor was the seeded updatedAt.
    expect(recordedCalls[0].since).toBe("2024-01-01T00:00:00.000Z");
    expect(recordedCalls[0].limit).toBe(3);
    // Second page: cursor advanced to the latest updatedAt from page 1.
    expect(recordedCalls[1].since).toBe("2024-01-01T00:00:03.000Z");

    // No third page — the second response was short.
    expect(recordedCalls).toHaveLength(2);

    // Cursor advanced to the most recent message overall.
    /** @type {any[]} */
    const cursors = await driver.query(
      "SELECT last_updated_at, last_server_id FROM sync_cursors WHERE conversation_id = ?",
      ["contact-1"],
    );
    expect(cursors[0].last_updated_at).toBe("2024-01-01T00:00:10.000Z");
    expect(cursors[0].last_server_id).toBe("srv-page2-1");

    // meta.last_incremental_sync_at persisted (Req 5.8).
    /** @type {any[]} */
    const meta = await driver.query(
      "SELECT value FROM meta WHERE key = 'last_incremental_sync_at'",
    );
    expect(meta).toHaveLength(1);
    expect(typeof meta[0].value).toBe("string");
    expect(engine.getStatus().lastIncrementalSyncAt).toBe(meta[0].value);
  });

  it("runs only one incremental pass per conversation concurrently (Req 5.7)", async () => {
    const { repository } = await makeRepository();

    // Seed a cursor.
    await repository.applyServerMessages({
      conversationId: "contact-1",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-base",
          sender: { _id: "contact-1" },
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      ],
    });

    /** @type {((value: unknown) => void) | null} */
    let releaseFirst = null;
    let messageCalls = 0;
    const firstCallStarted = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [{ _id: "contact-1" }],
      "/api/channels": async () => [],
      "/api/messages/private/contact-1": async () => {
        messageCalls += 1;
        if (messageCalls === 1) {
          // Block the first call until the second one has had a chance
          // to be issued — which proves the second one was coalesced
          // into the first (or queued behind the conversation mutex).
          await firstCallStarted;
        }
        return []; // empty page → engine stops paging immediately
      },
    });

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });

    const a = engine.incremental();
    const b = engine.incremental();
    // Let microtasks run so both calls reach the conversation lookup.
    await new Promise((r) => setTimeout(r, 10));
    if (releaseFirst) releaseFirst(undefined);
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    // Critical: only ONE network call landed for `contact-1` despite two
    // overlapping `incremental()` calls (Req 5.7).
    expect(messageCalls).toBe(1);
  });

  it("prioritizes conversations with unread messages first during incremental sync", async () => {
    const { repository } = await makeRepository();

    /** @type {string[]} */
    const callOrder = [];

    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [
        { _id: "contact-1", unreadCount: 0 },
        { _id: "contact-2", unreadCount: 5 },
      ],
      "/api/channels": async () => [],
      "/api/messages/private/contact-1": async () => {
        callOrder.push("contact-1");
        return [];
      },
      "/api/messages/private/contact-2": async () => {
        callOrder.push("contact-2");
        return [];
      },
    });

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });

    const result = await engine.incremental();
    expect(result.ok).toBe(true);
    // contact-2 has 5 unread messages, contact-1 has 0. contact-2 must be called first.
    expect(callOrder).toEqual(["contact-2", "contact-1"]);
  });
});

// ---------------------------------------------------------------------------
// applyLiveEvent dispatch table (§3.3)
// ---------------------------------------------------------------------------

describe("SyncEngine.applyLiveEvent", () => {
  /**
   * Build a fake repository that records every dispatched call without
   * touching SQLite. The SQL paths are already covered by the bootstrap /
   * incremental tests above; here we just want to verify the dispatch
   * table.
   */
  function makeFakeRepository() {
    /** @type {Array<{ method: string, args: unknown }>} */
    const calls = [];
    return {
      isReady: () => true,
      applyServerMessages: async (args) => {
        calls.push({ method: "applyServerMessages", args });
        return { inserted: 0, updated: 0, ignored: 0 };
      },
      applyLiveMessage: async (m) => {
        calls.push({ method: "applyLiveMessage", args: m });
      },
      applyDeletion: async (a) => {
        calls.push({ method: "applyDeletion", args: a });
      },
      applyStatusUpdate: async (a) => {
        calls.push({ method: "applyStatusUpdate", args: a });
      },
      getDriver: () => ({
        query: async () => [],
        run: async () => ({ changes: 0 }),
      }),
      getMutex: () => null,
      _calls: calls,
    };
  }

  it("dispatches receiveMessage to applyLiveMessage and resolves the clientTempId deferred", async () => {
    const repository = makeFakeRepository();
    const tempIdRegistry = createClientTempIdRegistry();
    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient: { get: vi.fn() },
      tempIdRegistry,
    });

    const waiter = tempIdRegistry.register("ctid-1", { timeoutMs: 1_000 });
    const payload = makeServerMessage({
      _id: "srv-1",
      clientTempId: "ctid-1",
    });
    await engine.applyLiveEvent({ kind: "receiveMessage", payload });

    expect(repository._calls).toEqual([
      { method: "applyLiveMessage", args: payload },
    ]);
    await expect(waiter).resolves.toEqual(payload);
  });

  it("dispatches receive-channel-message to applyLiveMessage and resolves the clientTempId deferred", async () => {
    const repository = makeFakeRepository();
    const tempIdRegistry = createClientTempIdRegistry();
    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient: { get: vi.fn() },
      tempIdRegistry,
    });

    const waiter = tempIdRegistry.register("ctid-2", { timeoutMs: 1_000 });
    const payload = {
      _id: "srv-ch-1",
      sender: { _id: "user-other" },
      receiver: null,
      channelId: "channel-1",
      messageType: "text",
      content: "hi",
      status: "sent",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      clientTempId: "ctid-2",
    };
    await engine.applyLiveEvent({ kind: "receive-channel-message", payload });

    expect(repository._calls).toEqual([
      { method: "applyLiveMessage", args: payload },
    ]);
    await expect(waiter).resolves.toEqual(payload);
  });

  it("dispatches messageSendFailed to tempIdRegistry.reject", async () => {
    const repository = makeFakeRepository();
    const tempIdRegistry = createClientTempIdRegistry();
    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient: { get: vi.fn() },
      tempIdRegistry,
    });

    const waiter = tempIdRegistry.register("ctid-3", { timeoutMs: 1_000 });
    await engine.applyLiveEvent({
      kind: "messageSendFailed",
      payload: { clientTempId: "ctid-3", error: "boom" },
    });

    expect(repository._calls).toEqual([]); // no repository write
    await expect(waiter).rejects.toMatchObject({ message: "boom" });
  });

  it("dispatches message-deleted to applyDeletion with deletedForEveryone=true", async () => {
    const repository = makeFakeRepository();
    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient: { get: vi.fn() },
      tempIdRegistry: createClientTempIdRegistry(),
    });

    await engine.applyLiveEvent({
      kind: "message-deleted",
      payload: { messageId: "srv-deleted-1" },
    });

    expect(repository._calls).toEqual([
      {
        method: "applyDeletion",
        args: { serverId: "srv-deleted-1", deletedForEveryone: true },
      },
    ]);
  });

  it("dispatches message-status-update to applyStatusUpdate with conversationId/fromUserId/status", async () => {
    const repository = makeFakeRepository();
    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient: { get: vi.fn() },
      tempIdRegistry: createClientTempIdRegistry(),
    });
    await engine.start({ userId: "user-self" });

    // Server emits `{ senderId, receiverId, status }`. The local user
    // (`user-self`) is the message's RECEIVER in this scenario, so the
    // conversationId resolves to `user-other` (the sender / fromUserId).
    await engine.applyLiveEvent({
      kind: "message-status-update",
      payload: {
        senderId: "user-other",
        receiverId: "user-self",
        status: "read",
      },
    });

    expect(repository._calls).toEqual([
      {
        method: "applyStatusUpdate",
        args: {
          conversationId: "user-other",
          fromUserId: "user-other",
          status: "read",
        },
      },
    ]);
  });

  it("ignores unknown kinds without throwing", async () => {
    const repository = makeFakeRepository();
    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient: { get: vi.fn() },
      tempIdRegistry: createClientTempIdRegistry(),
    });
    await engine.applyLiveEvent({
      kind: /** @type {any} */ ("unknown-event"),
      payload: {},
    });
    expect(repository._calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getStatus / lifecycle
// ---------------------------------------------------------------------------

describe("SyncEngine.getStatus and lifecycle", () => {
  it("reports idle phase before start and ready after start", async () => {
    const { repository } = await makeRepository();
    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [],
      "/api/channels": async () => [],
    });
    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });
    expect(engine.getStatus().phase).toBe("idle");
    await engine.start({ userId: "user-self" });
    // start() kicks off bootstrap in the background; the phase is
    // either "bootstrap" (if the initial fetch is still in flight) or
    // "ready" (if it already completed). Both are acceptable here —
    // we just want to confirm `start` cleanly advanced past `idle`.
    expect(["bootstrap", "ready"]).toContain(engine.getStatus().phase);
    await engine.stop();
    expect(engine.getStatus().phase).toBe("idle");
  });
});


// ---------------------------------------------------------------------------
// refreshConversation() — sequential chat-open sync
// ---------------------------------------------------------------------------
// These tests cover the behaviour the sequential chat-open fix in
// MessageContainer depends on:
//   1. A successful refresh fetches messages newer than the cursor and
//      writes them to the repository.
//   2. When the engine is offline the call returns immediately with
//      ok:false so the Promise.race timeout never needs to fire.
//   3. The call can safely be raced with a Promise-based timeout without
//      throwing — i.e. if the timeout wins, the fetch continues in the
//      background without affecting the caller.
//   4. A network error is absorbed (returns ok:false) rather than thrown,
//      so the `.catch(() => {})` wrapper in MessageContainer is redundant-
//      but-correct defensive coding.

describe("SyncEngine.refreshConversation", () => {
  it("fetches new messages for a DM and writes them to the repository", async () => {
    const { repository, driver } = await makeRepository();

    // Seed a sync cursor so incremental knows where to start from.
    await driver.run(
      "INSERT INTO sync_cursors (conversation_id, conversation_type, last_created_at, last_server_id) VALUES (?, ?, ?, ?)",
      ["user-other", "dm", "2024-01-01T00:00:00.000Z", "srv-old"],
    );

    const newMessage = makeServerMessage({
      _id: "srv-new",
      sender: { _id: "user-other" },
      createdAt: "2024-01-01T00:01:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
    });

    const apiClient = makeApiClient({
      "/api/messages/private/user-other": async () => [newMessage],
    });

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });
    await engine.start({ userId: "user-self" });

    const result = await engine.refreshConversation({
      conversationId: "user-other",
      conversationType: "dm",
    });

    expect(result.ok).toBe(true);
    expect(result.messagesApplied).toBeGreaterThan(0);

    // The new message should now be persisted in SQLite.
    const rows = await driver.query(
      "SELECT server_id FROM messages WHERE conversation_id = ?",
      ["user-other"],
    );
    expect(
      rows.map((r) => /** @type {{ server_id: string }} */ (r).server_id),
    ).toContain("srv-new");
  });

  it("returns ok:false immediately when the engine is offline", async () => {
    const { repository } = await makeRepository();
    const apiClient = makeApiClient({
      "/api/users/dm-contacts": async () => [],
      "/api/channels": async () => [],
    });

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });
    // Await bootstrap fully so all background network calls complete
    // before we record the baseline.
    await engine.start({ userId: "user-self" });
    await engine.bootstrap();

    const callsBeforeOffline = apiClient.calls.length;

    // Simulate going offline before the chat is opened.
    engine.onConnectivityChange("offline");

    const result = await engine.refreshConversation({
      conversationId: "user-other",
      conversationType: "dm",
    });

    // Must return fast with ok:false — no additional network calls made.
    expect(result.ok).toBe(false);
    expect(apiClient.calls.length).toBe(callsBeforeOffline);
  });

  it("can be safely raced with a timeout — timeout winning does not throw", async () => {
    const { repository } = await makeRepository();

    // The network call takes longer than the timeout will in a real app.
    // We simulate a slow network with a never-resolving stub.
    let resolveSlowFetch = /** @type {(v: unknown) => void} */ (() => {});
    const slowFetchPromise = new Promise((resolve) => {
      resolveSlowFetch = resolve;
    });

    const apiClient = {
      get: vi.fn(async () => {
        await slowFetchPromise;
        return { data: [] };
      }),
    };

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });
    await engine.start({ userId: "user-self" });

    // This mirrors exactly what MessageContainer does: race the sync
    // against a timeout. The timeout should win cleanly without throwing.
    const TIMEOUT_MS = 10; // very short for the test
    const syncTimeout = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));

    await expect(
      Promise.race([
        engine
          .refreshConversation({
            conversationId: "user-other",
            conversationType: "dm",
          })
          .catch(() => {}),
        syncTimeout,
      ]),
    ).resolves.not.toThrow();

    // Let the slow fetch resolve so the promise chain finishes and
    // Vitest does not report open handles.
    resolveSlowFetch(undefined);
  });

  it("absorbs network errors and returns ok:false rather than throwing", async () => {
    const { repository } = await makeRepository();

    const apiClient = {
      get: vi.fn(async () => {
        throw new Error("Network unavailable");
      }),
    };

    const engine = createSyncEngine({
      repository,
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });
    await engine.start({ userId: "user-self" });

    // Should resolve (not reject) with ok:false.
    const result = await engine.refreshConversation({
      conversationId: "user-other",
      conversationType: "dm",
    });

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start() — warm-boot blocking semantics
// ---------------------------------------------------------------------------
// On a warm boot, the sidebar hydrates from the local DB BEFORE
// `OfflineProvider` calls `engine.start()`. If `start()` does not block
// on the first incremental, the user sees stale `unread_count` /
// `last_message` values, then watches them "drop" 1-2s later when
// incremental lands. The fix is for `start()` to await incremental so
// the sidebar's first paint is already consistent with the server.
// Cold-boot bootstrap is intentionally left fire-and-forget (a cold
// bootstrap can take 10+ seconds and the local DB is empty anyway).

describe("SyncEngine.start blocks on warm-boot incremental", () => {
  it("does not resolve until the first incremental pass completes", async () => {
    const { repository } = await makeRepository();

    // Deferred we control: start() must block until this resolves.
    let resolveIncrementalFetch = /** @type {(v: unknown) => void} */ (
      () => {}
    );
    const incrementalFetchPromise = new Promise((resolve) => {
      resolveIncrementalFetch = resolve;
    });

    // Build an apiClient whose `.get` is the unified-incremental
    // endpoint. Any other endpoint (per-conversation) is left unstubbed
    // and would throw — the test never reaches the fallback path
    // because the unified path is taken (lastIncrementalSyncAt is set
    // by the meta hydration below).
    const apiClient = {
      get: vi.fn(async (url) => {
        if (typeof url === "string" && url.includes("/api/messages/updates")) {
          await incrementalFetchPromise;
          return { data: { messages: [], contacts: [], channels: [] } };
        }
        throw Object.assign(new Error(`apiClient stub: no route for ${url}`), {
          code: "NO_STUB_ROUTE",
          url,
        });
      }),
    };

    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });

    // Seed `last_incremental_sync_at` so `hydrateLastIncrementalSyncAt`
    // sets the in-memory cursor and `incremental()` takes the unified
    // path (the path that fetches /api/messages/updates — our
    // controllable deferred).
    const driver = /** @type {any} */ (repository.getDriver());
    await driver.run(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      ["last_incremental_sync_at", "2024-01-01T00:00:00.000Z"],
    );
    await driver.run(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      ["bootstrap_completed_at", "2024-01-01T00:00:00.000Z"],
    );
    // Seed a sync_cursors row too so shouldBootstrap() returns false.
    await driver.run(
      "INSERT INTO sync_cursors (conversation_id, conversation_type, last_updated_at, last_server_id) VALUES (?, ?, ?, ?)",
      ["user-other", "dm", "2024-01-01T00:00:00.000Z", "srv-old"],
    );

    // Kick off start() but DO NOT await — we want to assert it is
    // still blocked on incremental.
    let startResolved = false;
    const startPromise = engine
      .start({ userId: "user-self" })
      .then(() => {
        startResolved = true;
      });

    // Yield a few microtasks + one macrotask so start() can run past
    // `hydrateLastIncrementalSyncAt`, `shouldBootstrap`, and into the
    // awaiting `incremental()`.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // start() must still be pending — it is blocked on our deferred.
    expect(startResolved).toBe(false);
    // The engine has advanced to the "incremental" phase.
    expect(engine.getStatus().phase).toBe("incremental");
    // The apiClient was actually called (start() is past the no-op
    // bootstrap path).
    expect(apiClient.get).toHaveBeenCalled();

    // Release the deferred — start() should now resolve.
    resolveIncrementalFetch(undefined);
    await startPromise;

    // start() has resolved. The phase should be "ready".
    expect(startResolved).toBe(true);
    expect(engine.getStatus().phase).toBe("ready");
  });

  it("resolves cleanly even if incremental throws (errors are absorbed)", async () => {
    const { repository } = await makeRepository();

    // The unified endpoint rejects — simulates a network error during
    // the warm-boot first sync.
    const apiClient = {
      get: vi.fn(async (url) => {
        if (typeof url === "string" && url.includes("/api/messages/updates")) {
          throw new Error("Network down");
        }
        throw Object.assign(new Error(`apiClient stub: no route for ${url}`), {
          code: "NO_STUB_ROUTE",
          url,
        });
      }),
    };

    const engine = createSyncEngine({
      repository: /** @type {any} */ (repository),
      apiClient,
      tempIdRegistry: createClientTempIdRegistry(),
      host: "",
      sleep: async () => {},
    });

    const driver = /** @type {any} */ (repository.getDriver());
    await driver.run(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      ["last_incremental_sync_at", "2024-01-01T00:00:00.000Z"],
    );
    await driver.run(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
      ["bootstrap_completed_at", "2024-01-01T00:00:00.000Z"],
    );
    await driver.run(
      "INSERT INTO sync_cursors (conversation_id, conversation_type, last_updated_at, last_server_id) VALUES (?, ?, ?, ?)",
      ["user-other", "dm", "2024-01-01T00:00:00.000Z", "srv-old"],
    );

    // Must resolve (not reject) despite the network error.
    await expect(engine.start({ userId: "user-self" })).resolves.not.toThrow();
  });
});

