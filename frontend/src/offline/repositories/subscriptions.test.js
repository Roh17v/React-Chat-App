// @ts-check
/**
 * Unit tests for the repository pub/sub layer (task 7.4 / Req 1.2 / Req 11.1).
 *
 * Drives the repository through `createTestSqliteDriver()` so the assertions
 * exercise the real SQL and the real post-commit emit path — no mocks for
 * the writes, no mocks for the subscription registry. Each test starts from
 * a freshly migrated empty DB.
 *
 * Covers:
 *   - subscribeMessages: fires with up-to-date rows after applyServerMessages,
 *     applyLiveMessage, applyDeletion, applyStatusUpdate
 *   - subscribeMessages: only the matching conversationId bucket fires
 *   - subscribeContacts: fires on DM writes
 *   - subscribeChannels: fires on channel writes
 *   - unsubscribe disables further notifications
 *   - a buggy listener does not break sibling listeners
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";
import { createRepository } from "./index.js";

/**
 * Build a repository wired to an in-memory SQLite test driver. Same factory
 * pattern as `writes.test.js`; kept local so the suite can be run in isolation.
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
 * Build a server-message payload aligned with the wire-format serializer.
 *
 * @param {Partial<{ _id: string, sender: string, receiver: string, content: string, createdAt: string, updatedAt: string, status: string, channelId: string, messageType: string, fileUrl: string, deletedForEveryone: boolean }>} overrides
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
    clientTempId: null,
  };
}

describe("repository.subscribeMessages", () => {
  /** @type {Awaited<ReturnType<typeof makeRepository>>} */
  let ctx;
  beforeEach(async () => {
    ctx = await makeRepository();
  });

  it("fires the listener with up-to-date rows after applyServerMessages", async () => {
    /** @type {any[][]} */
    const calls = [];
    const unsub = ctx.repository.subscribeMessages("user-other", (msgs) => {
      calls.push(msgs);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-a",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0].serverId).toBe("srv-a");
    expect(calls[0][0].conversationId).toBe("user-other");
    expect(calls[0][0].syncState).toBe("confirmed");

    unsub();
  });

  it("fires the listener after applyLiveMessage", async () => {
    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeMessages("user-other", (msgs) => {
      calls.push(msgs);
    });

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

    expect(calls).toHaveLength(1);
    expect(calls[0][0].serverId).toBe("srv-live");
    expect(calls[0][0].status).toBe("delivered");
  });

  it("fires the listener after applyDeletion with cleared content", async () => {
    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-del",
          content: "preview",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      ],
    });

    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeMessages("user-other", (msgs) => {
      calls.push(msgs);
    });

    await ctx.repository.applyDeletion({
      serverId: "srv-del",
      deletedForEveryone: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0].serverId).toBe("srv-del");
    expect(calls[0][0].deletedForEveryone).toBe(1);
    expect(calls[0][0].content).toBeNull();
  });

  it("fires the listener after applyStatusUpdate", async () => {
    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-a",
          sender: "user-other",
          receiver: "user-self",
          status: "delivered",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      ],
    });

    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeMessages("user-other", (msgs) => {
      calls.push(msgs);
    });

    await ctx.repository.applyStatusUpdate({
      conversationId: "user-other",
      fromUserId: "user-other",
      status: "read",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0].status).toBe("read");
  });

  it("does not fire listeners for unrelated conversations", async () => {
    /** @type {any[][]} */
    const otherCalls = [];
    /** @type {any[][]} */
    const targetCalls = [];
    ctx.repository.subscribeMessages("user-other", (msgs) => {
      targetCalls.push(msgs);
    });
    ctx.repository.subscribeMessages("user-stranger", (msgs) => {
      otherCalls.push(msgs);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [makeServerMessage({ _id: "srv-a" })],
    });

    expect(targetCalls).toHaveLength(1);
    expect(otherCalls).toHaveLength(0);
  });

  it("stops firing after unsubscribe", async () => {
    /** @type {any[][]} */
    const calls = [];
    const unsub = ctx.repository.subscribeMessages("user-other", (msgs) => {
      calls.push(msgs);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [makeServerMessage({ _id: "srv-1" })],
    });
    expect(calls).toHaveLength(1);

    unsub();

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-2",
          createdAt: "2024-01-01T00:01:00.000Z",
          updatedAt: "2024-01-01T00:01:00.000Z",
        }),
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("isolates a throwing listener from sibling listeners", async () => {
    /** @type {any[][]} */
    const goodCalls = [];
    let badInvoked = 0;
    ctx.repository.subscribeMessages("user-other", () => {
      badInvoked += 1;
      throw new Error("boom");
    });
    ctx.repository.subscribeMessages("user-other", (msgs) => {
      goodCalls.push(msgs);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [makeServerMessage({ _id: "srv-x" })],
    });

    expect(badInvoked).toBe(1);
    expect(goodCalls).toHaveLength(1);
    expect(goodCalls[0][0].serverId).toBe("srv-x");

    const events = ctx.diagnostics.snapshot().events;
    const failureEvent = events.find(
      (e) => e.code === "SUBSCRIBE_LISTENER_FAILED",
    );
    expect(failureEvent).toBeDefined();
  });

  it("treats invalid arguments as no-op subscriptions", () => {
    // Empty conversation id
    const a = ctx.repository.subscribeMessages("", () => {});
    expect(typeof a).toBe("function");
    a();
    // Non-function listener
    const b = ctx.repository.subscribeMessages("conv", /** @type {any} */ (null));
    expect(typeof b).toBe("function");
    b();
  });
});

describe("repository.subscribeContacts", () => {
  it("fires after applyServerMessages on a DM", async () => {
    const ctx = await makeRepository();
    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeContacts((contacts) => {
      calls.push(contacts);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [makeServerMessage({ _id: "srv-c" })],
    });

    // Contacts table starts empty in this scaffold (task 7.2 only writes
    // messages); the contract here is that the listener fires with the
    // current contact set, not that the row count is non-zero.
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0])).toBe(true);
  });

  it("does not fire on channel writes", async () => {
    const ctx = await makeRepository();
    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeContacts((contacts) => {
      calls.push(contacts);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "ch-1",
      conversationType: "channel",
      messages: [
        makeServerMessage({
          _id: "srv-ch",
          channelId: "ch-1",
          receiver: undefined,
        }),
      ],
    });

    expect(calls).toHaveLength(0);
  });

  it("stops firing after unsubscribe", async () => {
    const ctx = await makeRepository();
    /** @type {any[][]} */
    const calls = [];
    const unsub = ctx.repository.subscribeContacts((contacts) => {
      calls.push(contacts);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [makeServerMessage({ _id: "srv-a" })],
    });
    expect(calls).toHaveLength(1);

    unsub();

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [
        makeServerMessage({
          _id: "srv-b",
          createdAt: "2024-01-01T00:01:00.000Z",
          updatedAt: "2024-01-01T00:01:00.000Z",
        }),
      ],
    });
    expect(calls).toHaveLength(1);
  });
});

describe("repository.resetUnreadCount", () => {
  it("resets unread_count to 0 and notifies contacts subscribers", async () => {
    const ctx = await makeRepository();

    const driver = ctx.driver;
    await driver.run(
      "INSERT INTO users (user_id, first_name, last_name, email, username, image, color_json, last_seen, updated_at) " +
        "VALUES ('user-1', 'Alice', 'Smith', 'alice@test.com', 'alice', null, null, null, ?)",
      [new Date().toISOString()]
    );
    await driver.run(
      "INSERT INTO contacts (user_id, last_message, last_message_at, unread_count, bootstrap_status, updated_at) " +
        "VALUES ('user-1', 'hey', '2024-01-01T00:00:00.000Z', 5, 'ready', ?)",
      [new Date().toISOString()]
    );

    const contactsBefore = await ctx.repository.getContacts();
    const contactBefore = contactsBefore.find((c) => c._id === "user-1");
    expect(contactBefore?.unreadCount).toBe(5);

    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeContacts((contacts) => {
      calls.push(contacts);
    });

    await ctx.repository.resetUnreadCount("user-1");

    const contactsAfter = await ctx.repository.getContacts();
    const contactAfter = contactsAfter.find((c) => c._id === "user-1");
    expect(contactAfter?.unreadCount).toBe(0);

    expect(calls).toHaveLength(1);
    const notifiedContact = calls[0].find((c) => c._id === "user-1");
    expect(notifiedContact?.unreadCount).toBe(0);
  });
});

describe("repository.subscribeChannels", () => {
  it("fires after applyServerMessages on a channel", async () => {
    const ctx = await makeRepository();
    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeChannels((channels) => {
      calls.push(channels);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "ch-1",
      conversationType: "channel",
      messages: [
        makeServerMessage({
          _id: "srv-ch",
          channelId: "ch-1",
          receiver: undefined,
        }),
      ],
    });

    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0])).toBe(true);
  });

  it("does not fire on DM writes", async () => {
    const ctx = await makeRepository();
    /** @type {any[][]} */
    const calls = [];
    ctx.repository.subscribeChannels((channels) => {
      calls.push(channels);
    });

    await ctx.repository.applyServerMessages({
      conversationId: "user-other",
      conversationType: "dm",
      messages: [makeServerMessage({ _id: "srv-dm" })],
    });

    expect(calls).toHaveLength(0);
  });
});
