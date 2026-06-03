// @ts-check
/**
 * Unit tests for the OutboundQueue + repository write integration (task 10.1).
 *
 * Covers the three repository entry points that 10.1 implemented
 * (`enqueueOutbound`, `markOutboundConfirmed`, `markOutboundFailed`) and
 * the OutboundQueue runtime: drain order, retry/backoff, FIFO order across
 * conversations, restart rollback, and confirmation merge.
 *
 * Drives the repository through `createTestSqliteDriver()` so the SQL is
 * exercised end-to-end. Socket and HTTP dependencies are stubbed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";
import { createPerConversationMutex } from "../utils/PerConversationMutex.js";
import { createRepository } from "../repositories/index.js";
import { createClientTempIdRegistry } from "./clientTempIdRegistry.js";
import { createOutboundQueue, MAX_ATTEMPTS } from "./OutboundQueue.js";

/**
 * Build a repository wired to an in-memory SQLite test driver.
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
 * Minimal stub socket: records every emit, exposes a `connected` flag.
 *
 * @param {{ connected?: boolean }} [opts]
 */
function makeSocket(opts = {}) {
  const emits = [];
  return {
    connected: opts.connected !== false,
    /**
     * @param {string} event
     * @param {Record<string, unknown>} payload
     */
    emit(event, payload) {
      emits.push({ event, payload });
    },
    emits,
  };
}

describe("repository.enqueueOutbound", () => {
  it("allocates monotonic queueSeq and inserts the optimistic message row", async () => {
    const { repository, driver } = await makeRepository();

    const a = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-other",
      conversationType: "dm",
      payload: { content: "hello" },
    });
    const b = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-other",
      conversationType: "dm",
      payload: { content: "world" },
    });

    expect(a.queueSeq).toBe(1);
    expect(b.queueSeq).toBe(2);
    expect(a.clientTempId).toBeTypeOf("string");
    expect(a.localMessage).toBeDefined();
    expect(a.localMessage?.status).toBe("pending");
    expect(a.localMessage?.syncState).toBe("local_only");
    expect(a.localMessage?.queueSeq).toBe(1);
    expect(a.localMessage?.clientTempId).toBe(a.clientTempId);

    const queueRows = await driver.query(
      "SELECT id, queue_seq, kind, status, client_temp_id, conversation_id, payload_json " +
        "FROM outbound_queue ORDER BY queue_seq ASC",
    );
    expect(queueRows).toHaveLength(2);
    expect(queueRows[0].queue_seq).toBe(1);
    expect(queueRows[0].kind).toBe("send_text");
    expect(queueRows[0].status).toBe("queued");
    expect(queueRows[1].queue_seq).toBe(2);

    const messageRows = await driver.query(
      "SELECT status, sync_state, queue_seq, client_temp_id FROM messages ORDER BY queue_seq ASC",
    );
    expect(messageRows).toHaveLength(2);
    expect(messageRows[0]).toEqual({
      status: "pending",
      sync_state: "local_only",
      queue_seq: 1,
      client_temp_id: a.clientTempId,
    });

    const meta = await driver.query(
      "SELECT value FROM meta WHERE key = 'next_queue_seq'",
    );
    expect(meta[0].value).toBe("2");
  });

  it("does not insert a messages row for non-message kinds", async () => {
    const { repository, driver } = await makeRepository();
    const result = await repository.enqueueOutbound({
      kind: "delete_for_me",
      conversationId: "user-other",
      conversationType: "dm",
      payload: { messageId: "srv-1" },
    });
    expect(result.queueSeq).toBe(1);
    expect(result.localMessage).toBeUndefined();
    const messages = await driver.query("SELECT COUNT(*) AS n FROM messages");
    expect(messages[0].n).toBe(0);
    const queue = await driver.query(
      "SELECT kind, client_temp_id FROM outbound_queue",
    );
    expect(queue).toEqual([{ kind: "delete_for_me", client_temp_id: null }]);
  });

  it("rejects invalid kinds and payloads without writing to the DB", async () => {
    const { repository, driver } = await makeRepository();
    await expect(
      repository.enqueueOutbound({
        kind: "garbage",
        conversationId: "x",
        conversationType: "dm",
      }),
    ).rejects.toMatchObject({ code: "INVALID_KIND" });
    await expect(
      repository.enqueueOutbound({
        kind: "send_text",
        conversationId: "x",
        conversationType: "dm",
        payload: { content: "" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD_CONTENT" });

    const queue = await driver.query("SELECT COUNT(*) AS n FROM outbound_queue");
    expect(queue[0].n).toBe(0);
  });
});

describe("repository.markOutboundConfirmed", () => {
  it("marks the queue row succeeded and merges the server payload by clientTempId", async () => {
    const { repository, driver } = await makeRepository();
    const enq = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-other",
      conversationType: "dm",
      payload: { content: "hi" },
    });

    const serverMessage = {
      _id: "srv-1",
      sender: { _id: "user-self" },
      receiver: { _id: "user-other" },
      messageType: "text",
      content: "hi",
      status: "sent",
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      clientTempId: enq.clientTempId,
    };

    await repository.markOutboundConfirmed({
      queueId: enq.id,
      serverMessage,
    });

    const queue = await driver.query(
      "SELECT status, last_error FROM outbound_queue WHERE id = ?",
      [enq.id],
    );
    expect(queue[0].status).toBe("succeeded");
    expect(queue[0].last_error).toBeNull();

    const msgs = await driver.query(
      "SELECT server_id, status, sync_state, client_temp_id, queue_seq " +
        "FROM messages WHERE client_temp_id = ?",
      [enq.clientTempId],
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      server_id: "srv-1",
      status: "sent",
      sync_state: "confirmed",
      client_temp_id: enq.clientTempId,
      queue_seq: enq.queueSeq,
    });
  });

  it("is a no-op when the queue row is missing", async () => {
    const { repository } = await makeRepository();
    await repository.markOutboundConfirmed({ queueId: "nope" });
    // No throw, no rows touched.
  });
});

describe("repository.markOutboundFailed", () => {
  it("flips the queue row to failed and the bound message to failed", async () => {
    const { repository, driver } = await makeRepository();
    const enq = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-other",
      conversationType: "dm",
      payload: { content: "x" },
    });

    await repository.markOutboundFailed({
      queueId: enq.id,
      error: "boom",
    });

    const queue = await driver.query(
      "SELECT status, last_error FROM outbound_queue WHERE id = ?",
      [enq.id],
    );
    expect(queue[0].status).toBe("failed");
    expect(queue[0].last_error).toBe("boom");

    const msgs = await driver.query(
      "SELECT status FROM messages WHERE client_temp_id = ?",
      [enq.clientTempId],
    );
    expect(msgs[0].status).toBe("failed");
  });

  it("does not flip a non-pending message status", async () => {
    const { repository, driver } = await makeRepository();
    const enq = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-other",
      conversationType: "dm",
      payload: { content: "x" },
    });
    // Manually flip the message to delivered (simulate a server confirm
    // happening before the queue's failure was finalized).
    await driver.run(
      "UPDATE messages SET status = 'delivered' WHERE client_temp_id = ?",
      [enq.clientTempId],
    );
    await repository.markOutboundFailed({ queueId: enq.id, error: "race" });
    const msgs = await driver.query(
      "SELECT status FROM messages WHERE client_temp_id = ?",
      [enq.clientTempId],
    );
    expect(msgs[0].status).toBe("delivered");
  });
});

describe("OutboundQueue drain", () => {
  it("drains queued items in queueSeq order and emits over the socket", async () => {
    const { repository, driver } = await makeRepository();
    const socket = makeSocket();
    const tempIdRegistry = createClientTempIdRegistry();

    // Enqueue a few items in mixed creation order.
    const a = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-a",
      conversationType: "dm",
      payload: { content: "first" },
    });
    const b = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-b",
      conversationType: "dm",
      payload: { content: "second" },
    });
    const c = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-a",
      conversationType: "dm",
      payload: { content: "third" },
    });

    const queue = createOutboundQueue({
      repository,
      socket,
      tempIdRegistry,
      // Force `online` without a live connectivity service.
      connectivity: null,
    });

    const drainPromise = queue.drain();

    // Resolve each clientTempId deferred in queueSeq order. The
    // OutboundQueue serializes drain so by the time the second emit
    // lands the first one must already have a deferred registered.
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.emits).toHaveLength(1);
    expect(socket.emits[0].payload.clientTempId).toBe(a.clientTempId);
    tempIdRegistry.resolve(a.clientTempId, {
      _id: "srv-a",
      sender: { _id: "user-self" },
      receiver: { _id: "user-a" },
      messageType: "text",
      content: "first",
      status: "sent",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      clientTempId: a.clientTempId,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(socket.emits[1].payload.clientTempId).toBe(b.clientTempId);
    tempIdRegistry.resolve(b.clientTempId, {
      _id: "srv-b",
      sender: { _id: "user-self" },
      receiver: { _id: "user-b" },
      messageType: "text",
      content: "second",
      status: "sent",
      createdAt: "2024-01-01T00:01:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
      clientTempId: b.clientTempId,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(socket.emits[2].payload.clientTempId).toBe(c.clientTempId);
    tempIdRegistry.resolve(c.clientTempId, {
      _id: "srv-c",
      sender: { _id: "user-self" },
      receiver: { _id: "user-a" },
      messageType: "text",
      content: "third",
      status: "sent",
      createdAt: "2024-01-01T00:02:00.000Z",
      updatedAt: "2024-01-01T00:02:00.000Z",
      clientTempId: c.clientTempId,
    });
    await drainPromise;

    expect(socket.emits.map((e) => e.payload.clientTempId)).toEqual([
      a.clientTempId,
      b.clientTempId,
      c.clientTempId,
    ]);

    const queueRows = await driver.query(
      "SELECT status FROM outbound_queue ORDER BY queue_seq ASC",
    );
    expect(queueRows.map((r) => r.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("schedules backoff after a transient failure and stops at MAX_ATTEMPTS", async () => {
    const { repository, driver } = await makeRepository();
    const socket = makeSocket();
    const tempIdRegistry = createClientTempIdRegistry();

    const a = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-a",
      conversationType: "dm",
      payload: { content: "x" },
    });

    let nowMs = 1_000_000;
    const queue = createOutboundQueue({
      repository,
      socket,
      tempIdRegistry,
      connectivity: null,
      now: () => nowMs,
      // Deterministic jitter (0).
      random: () => 0.5,
      confirmationTimeoutMs: 50,
    });

    // Drive 5 failures by rejecting the deferred each time. Skip backoff
    // delay by advancing `nowMs` past `next_attempt_at` between drains.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const drainPromise = queue.drain();
      await new Promise((r) => setTimeout(r, 0));
      // Reject the latest deferred. The OutboundQueue registered it when
      // it emitted; we just have to look up which clientTempId is in
      // flight. The clientTempId is stable across retries (Req 6.6).
      tempIdRegistry.reject(
        a.clientTempId,
        Object.assign(new Error("fail-" + i), { code: "TEST" }),
      );
      await drainPromise;
      // Advance time past the scheduled next_attempt_at so the next drain
      // sees the row as due.
      nowMs += 24 * 60 * 60 * 1000;
    }

    const finalRow = await driver.query(
      "SELECT status, attempts, last_error FROM outbound_queue WHERE id = ?",
      [a.id],
    );
    expect(finalRow[0].status).toBe("failed");
    expect(finalRow[0].attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS - 1);

    const msg = await driver.query(
      "SELECT status FROM messages WHERE client_temp_id = ?",
      [a.clientTempId],
    );
    expect(msg[0].status).toBe("failed");
  });

  it("rolls in_flight rows back to queued on start (restart durability)", async () => {
    const { repository, driver } = await makeRepository();
    const socket = makeSocket();
    const tempIdRegistry = createClientTempIdRegistry();

    const a = await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-a",
      conversationType: "dm",
      payload: { content: "x" },
    });
    // Simulate a previous process that crashed mid-flight.
    await driver.run(
      "UPDATE outbound_queue SET status = 'in_flight' WHERE id = ?",
      [a.id],
    );

    const queue = createOutboundQueue({
      repository,
      socket,
      tempIdRegistry,
      connectivity: null,
      timerIntervalMs: 1_000_000, // disable the 60s timer for this test
    });

    await queue.start();
    // After start, the row should have been rolled back to queued and
    // the initial drain should have re-emitted it.
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.emits).toHaveLength(1);
    expect(socket.emits[0].payload.clientTempId).toBe(a.clientTempId);
    tempIdRegistry.resolve(a.clientTempId, {
      _id: "srv-a",
      sender: { _id: "user-self" },
      receiver: { _id: "user-a" },
      messageType: "text",
      content: "x",
      status: "sent",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      clientTempId: a.clientTempId,
    });
    await queue.stop();
  });

  it("triggerDrain is a no-op when offline", async () => {
    const { repository } = await makeRepository();
    const socket = makeSocket({ connected: false });
    const tempIdRegistry = createClientTempIdRegistry();

    await repository.enqueueOutbound({
      kind: "send_text",
      conversationId: "user-a",
      conversationType: "dm",
      payload: { content: "x" },
    });

    const queue = createOutboundQueue({
      repository,
      socket,
      tempIdRegistry,
      connectivity: { current: () => "offline", subscribe: () => () => {} },
    });

    queue.triggerDrain();
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.emits).toHaveLength(0);
  });

  it("processes delete_for_me via apiClient.patch", async () => {
    const { repository, driver } = await makeRepository();
    const socket = makeSocket();
    const tempIdRegistry = createClientTempIdRegistry();
    const apiClient = {
      post: vi.fn(),
      patch: vi.fn(async () => ({ data: { success: true } })),
    };

    const enq = await repository.enqueueOutbound({
      kind: "delete_for_me",
      conversationId: "user-a",
      conversationType: "dm",
      payload: { messageId: "srv-42" },
    });

    const queue = createOutboundQueue({
      repository,
      socket,
      apiClient,
      tempIdRegistry,
      connectivity: null,
    });
    await queue.drain();

    expect(apiClient.patch).toHaveBeenCalledWith(
      "/api/messages/srv-42/delete-for-me",
      {},
      { withCredentials: true },
    );
    const queueRow = await driver.query(
      "SELECT status FROM outbound_queue WHERE id = ?",
      [enq.id],
    );
    expect(queueRow[0].status).toBe("succeeded");
  });
});

describe("clientTempIdRegistry", () => {
  it("resolves a registered deferred", async () => {
    const reg = createClientTempIdRegistry();
    const promise = reg.register("tmp-1");
    reg.resolve("tmp-1", { ok: true });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects on timeout", async () => {
    const reg = createClientTempIdRegistry();
    const promise = reg.register("tmp-1", { timeoutMs: 5 });
    await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("replaces a previous deferred when register is called twice", async () => {
    const reg = createClientTempIdRegistry();
    const first = reg.register("tmp-1");
    const second = reg.register("tmp-1");
    await expect(first).rejects.toMatchObject({ code: "REPLACED" });
    reg.resolve("tmp-1", "ok");
    await expect(second).resolves.toBe("ok");
  });
});
