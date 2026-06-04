// @ts-check
/**
 * Incremental_Sync helpers — the per-conversation `since`-based pager
 * and the orchestrator that scans every known conversation.
 *
 * Implements task 11.2 of the offline-support spec, validating
 * Requirements 5.1, 5.2, 5.3 (and the supporting cursor / dedup
 * behavior of 5.4–5.8 the repository delivers).
 *
 * The helpers are stateless: every dependency (axios `apiClient`,
 * repository, diagnostics, the per-conversation in-flight map, the
 * cursor read/write helpers) is injected by the caller.
 * {@link createSyncEngine} composes these helpers with its own mutable
 * state (`phase`, `lastIncrementalSyncAt`, `incrementalInFlight`).
 *
 * Behavior preserved verbatim from the inline implementation that
 * landed in task 11.1:
 *
 *   - per conversation: read `sync_cursors[c].last_created_at = T`,
 *     call `GET /api/messages/.../:id?since=T&limit=200` (Req 5.3),
 *     append-and-page until a short page (Req 5.3)
 *   - the repository advances the cursor inside the same transaction
 *     that upserts the page (Req 5.4); this helper never advances the
 *     cursor itself
 *   - single in-flight per conversation (Req 5.7) is enforced via the
 *     injected `inFlight` map: a second concurrent call for the same
 *     id awaits the existing promise instead of issuing a second
 *     `GET`
 *   - pages are capped at `incrementalPageCap` to defend against a
 *     misbehaving backend that always returns full pages — the
 *     repository's cursor advance lets the next call resume cleanly
 *
 * @module offline/sync/incremental
 */

import {
  PRIVATE_CONTACT_MESSAGES_ROUTE,
  CHANNEL_MESSAGES_ROUTE,
  SYNC_UPDATES_ROUTE,
} from "../../utils/constants.js";

import { describeError } from "./syncHelpers.js";
import { fetchConversationList } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default page size for incremental fetches. Matches the design's
 * §3.3 call-out of `limit=200`.
 */
export const DEFAULT_PAGE_LIMIT = 200;

/**
 * Hard cap on incremental pages per conversation per call. A single
 * `incremental()` invocation must not loop forever if the backend is
 * misbehaving (e.g. always returns a full page). The repository's
 * `applyServerMessages` advances the cursor on every successful commit,
 * so any subsequent call simply resumes from where this one stopped.
 */
export const INCREMENTAL_PAGE_CAP = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, type: "dm"|"channel" }} ConversationRef
 */

/**
 * @typedef {Object} IncrementalCursor
 * @property {"dm"|"channel"} type
 * @property {string|null} lastCreatedAt
 * @property {string|null} lastServerId
 */

/**
 * @typedef {Object} IncrementalRepository
 * @property {(args: { conversationId: string, conversationType: "dm"|"channel", messages: unknown[], sourceCursor?: object }) => Promise<{ inserted: number, updated: number, ignored: number }>} applyServerMessages
 * @property {(contacts: unknown[]) => Promise<{ upserted: number, ignored: number }>} [applyContacts]
 * @property {(channels: unknown[]) => Promise<{ upserted: number, ignored: number }>} [applyChannels]
 */

/**
 * @typedef {Object} IncrementalApiClient
 * @property {(url: string, opts?: { withCredentials?: boolean, params?: Record<string, unknown> }) => Promise<{ data?: unknown }>} get
 */

/**
 * @typedef {Object} IncrementalDiagnostics
 * @property {(e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void} log
 */

/**
 * @typedef {Object} IncrementalConversationResult
 * @property {boolean} ok
 * @property {number} batchesApplied
 * @property {number} messagesApplied
 */

/**
 * @typedef {Object} IncrementalResult
 * @property {boolean} ok
 * @property {number} conversationsScanned
 * @property {number} batchesApplied
 * @property {number} messagesApplied
 * @property {string[]} failedConversationIds
 * @property {number} durationMs
 */

/**
 * @typedef {Object} IncrementalConversationOptions
 * @property {ConversationRef} conversation
 * @property {IncrementalRepository} repository
 * @property {IncrementalApiClient} apiClient
 * @property {IncrementalDiagnostics} diagnostics
 * @property {(pathOrUrl: string) => string} buildUrl
 * @property {() => Promise<Map<string, IncrementalCursor>>} readCursors
 * @property {Map<string, Promise<IncrementalConversationResult>>} inFlight
 * @property {number} [pageLimit]
 * @property {number} [incrementalPageCap]
 * @property {() => number} [now]
 */

/**
 * @typedef {Object} IncrementalOptions
 * @property {IncrementalRepository} repository
 * @property {IncrementalApiClient} apiClient
 * @property {IncrementalDiagnostics} diagnostics
 * @property {(pathOrUrl: string) => string} buildUrl
 * @property {() => Promise<Map<string, IncrementalCursor>>} readCursors
 * @property {(isoTimestamp: string) => Promise<void>} setLastIncrementalSyncAt
 * @property {Map<string, Promise<IncrementalConversationResult>>} inFlight
 * @property {string|null} [userId]
 * @property {number} [pageLimit]
 * @property {number} [incrementalPageCap]
 * @property {() => number} [now]
 * @property {(phase: "incremental"|"ready") => void} [onPhaseChange]
 */

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * @param {IncrementalApiClient} apiClient
 * @param {(p: string) => string} buildUrl
 * @returns {<T>(pathOrUrl: string, params?: Record<string, unknown>) => Promise<T>}
 */
function makeHttpGet(apiClient, buildUrl) {
  return async function httpGet(pathOrUrl, params) {
    const url = buildUrl(pathOrUrl);
    /** @type {{ withCredentials: boolean, params?: Record<string, unknown> }} */
    const opts = { withCredentials: true };
    if (params != null && Object.keys(params).length > 0) {
      opts.params = params;
    }
    const response = await apiClient.get(url, opts);
    return /** @type {any} */ (response != null ? response.data : undefined);
  };
}

// ---------------------------------------------------------------------------
// Per-conversation runner
// ---------------------------------------------------------------------------

/**
 * Pull pages for a single conversation until the server returns a short
 * page. The repository advances `sync_cursors` inside its own
 * transaction (Req 5.4), so this loop just re-reads the cursor between
 * pages rather than tracking it locally.
 *
 * Single-in-flight per conversation (Req 5.7) is enforced by the
 * injected `inFlight` map: a second concurrent call for the same id
 * returns the existing promise instead of starting a fresh pass. The
 * cross-writer serialization of Req 5.6 is delegated to the
 * repository — every `applyServerMessages` call grabs the
 * conversation mutex internally, so a live event landing for the same
 * conversation while the page is being applied still serializes
 * correctly. Wrapping this loop in the same mutex would deadlock the
 * inner `applyServerMessages` call (the chained-promise mutex is not
 * re-entrant).
 *
 * @param {IncrementalConversationOptions} options
 * @returns {Promise<IncrementalConversationResult>}
 */
export function runIncrementalConversation(options) {
  if (options == null || options.conversation == null) {
    throw new Error("runIncrementalConversation: conversation is required");
  }
  if (options.repository == null) {
    throw new Error("runIncrementalConversation: repository is required");
  }
  if (options.apiClient == null || typeof options.apiClient.get !== "function") {
    throw new Error("runIncrementalConversation: apiClient.get is required");
  }
  if (options.diagnostics == null) {
    throw new Error("runIncrementalConversation: diagnostics is required");
  }
  if (typeof options.buildUrl !== "function") {
    throw new Error("runIncrementalConversation: buildUrl is required");
  }
  if (typeof options.readCursors !== "function") {
    throw new Error("runIncrementalConversation: readCursors is required");
  }
  if (!(options.inFlight instanceof Map)) {
    throw new Error("runIncrementalConversation: inFlight Map is required");
  }

  const conv = options.conversation;
  const inFlight = options.inFlight;
  const existing = inFlight.get(conv.id);
  if (existing != null) return existing;

  const httpGet = makeHttpGet(options.apiClient, options.buildUrl);
  const pageLimit =
    typeof options.pageLimit === "number" && options.pageLimit > 0
      ? Math.floor(options.pageLimit)
      : DEFAULT_PAGE_LIMIT;
  const pageCap =
    typeof options.incrementalPageCap === "number" && options.incrementalPageCap > 0
      ? Math.floor(options.incrementalPageCap)
      : INCREMENTAL_PAGE_CAP;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const repository = options.repository;
  const diagnostics = options.diagnostics;
  const readCursors = options.readCursors;

  const route =
    conv.type === "dm" ? PRIVATE_CONTACT_MESSAGES_ROUTE : CHANNEL_MESSAGES_ROUTE;

  const promise = (async () => {
    let batchesApplied = 0;
    let messagesApplied = 0;
    let pages = 0;
    try {
      while (pages < pageCap) {
        pages += 1;
        const cursors = await readCursors();
        const cursor =
          cursors.get(conv.id) || {
            type: conv.type,
            lastCreatedAt: null,
            lastServerId: null,
          };
        /** @type {Record<string, unknown>} */
        const params = { limit: pageLimit };
        if (cursor.lastCreatedAt != null) {
          params.since = cursor.lastCreatedAt;
        }
        const startedAt = now();
        /** @type {unknown[]} */
        let page = [];
        try {
          const data = await httpGet(`${route}/${conv.id}`, params);
          if (Array.isArray(data)) page = data;
        } catch (err) {
          diagnostics.log({
            category: "incremental",
            code: "INCREMENTAL_PAGE_FAILED",
            outcome: "error",
            durationMs: now() - startedAt,
            meta: {
              conversationId: conv.id,
              conversationType: conv.type,
              reason: describeError(err),
            },
          });
          return { ok: false, batchesApplied, messagesApplied };
        }

        if (page.length === 0) {
          // Even an empty page on a conversation with no cursor
          // (i.e. a brand-new conversation) is fine — the
          // repository's `applyServerMessages` short-circuits on
          // empty input and does not touch the cursor.
          break;
        }

        // Without a since cursor the backend's legacy code path
        // returns newest-first. With a since cursor it returns
        // ascending — the shape `applyServerMessages` expects.
        // Convert the legacy shape into ascending order so the
        // conflict resolver always sees ascending input.
        if (cursor.lastCreatedAt == null) {
          page = page.slice().reverse();
        }

        /** @type {{ lastServerId?: string, lastCreatedAt?: string, lastSyncedAt?: string }} */
        const sourceCursor = {
          lastSyncedAt: new Date(now()).toISOString(),
        };
        if (cursor.lastCreatedAt != null) sourceCursor.lastCreatedAt = cursor.lastCreatedAt;
        if (cursor.lastServerId != null) sourceCursor.lastServerId = cursor.lastServerId;

        await repository.applyServerMessages({
          conversationId: conv.id,
          conversationType: conv.type,
          messages: page,
          sourceCursor,
        });
        batchesApplied += 1;
        messagesApplied += page.length;
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_PAGE_OK",
          outcome: "ok",
          durationMs: now() - startedAt,
          meta: {
            conversationId: conv.id,
            conversationType: conv.type,
            messages: page.length,
            page: pages,
          },
        });

        // Short page → caught up. Stop paging.
        if (page.length < pageLimit) break;
      }
      return { ok: true, batchesApplied, messagesApplied };
    } finally {
      inFlight.delete(conv.id);
    }
  })();

  inFlight.set(conv.id, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Full incremental pass
// ---------------------------------------------------------------------------

/**
 * Run a single Incremental_Sync pass: build the union of cursored
 * conversations and live contact / channel lists, then run
 * {@link runIncrementalConversation} for each. Persists
 * `meta.last_incremental_sync_at` (Req 5.8) when at least one
 * conversation made progress.
 *
 * @param {IncrementalOptions} options
 * @returns {Promise<IncrementalResult>}
 */
export async function runIncremental(options) {
  if (options == null || options.repository == null) {
    throw new Error("runIncremental: repository is required");
  }
  if (options.apiClient == null || typeof options.apiClient.get !== "function") {
    throw new Error("runIncremental: apiClient.get is required");
  }
  if (options.diagnostics == null) {
    throw new Error("runIncremental: diagnostics is required");
  }
  if (typeof options.buildUrl !== "function") {
    throw new Error("runIncremental: buildUrl is required");
  }
  if (typeof options.readCursors !== "function") {
    throw new Error("runIncremental: readCursors is required");
  }
  if (typeof options.setLastIncrementalSyncAt !== "function") {
    throw new Error("runIncremental: setLastIncrementalSyncAt is required");
  }
  if (!(options.inFlight instanceof Map)) {
    throw new Error("runIncremental: inFlight Map is required");
  }

  const repository = options.repository;
  const apiClient = options.apiClient;
  const diagnostics = options.diagnostics;
  const buildUrl = options.buildUrl;
  const readCursors = options.readCursors;
  const setLastIncrementalSyncAt = options.setLastIncrementalSyncAt;
  const inFlight = options.inFlight;
  const pageLimit =
    typeof options.pageLimit === "number" && options.pageLimit > 0
      ? Math.floor(options.pageLimit)
      : DEFAULT_PAGE_LIMIT;
  const pageCap =
    typeof options.incrementalPageCap === "number" && options.incrementalPageCap > 0
      ? Math.floor(options.incrementalPageCap)
      : INCREMENTAL_PAGE_CAP;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const onPhaseChange =
    typeof options.onPhaseChange === "function" ? options.onPhaseChange : null;

  const startedAt = now();
  if (onPhaseChange) onPhaseChange("incremental");
  diagnostics.log({
    category: "incremental",
    code: "INCREMENTAL_STARTED",
    outcome: "ok",
    meta: { userId: options.userId != null ? options.userId : null },
  });

  // The conversation set is the union of cursored conversations (any
  // conversation we've seen at least one message for) and the live
  // contact / channel lists. Cursored set alone is sufficient for the
  // common case; pulling the lists too lets us catch up conversations
  // that appeared while offline (e.g. a new DM partner who messaged
  // first while we were disconnected). List fetch failures are
  // non-fatal here — we fall back to whatever cursors we already have.
  /** @type {Map<string, "dm"|"channel">} */
  const conversations = new Map();
  try {
    const cursors = await readCursors();
    cursors.forEach((c, id) => {
      conversations.set(id, c.type);
    });
  } catch (err) {
    diagnostics.log({
      category: "incremental",
      code: "INCREMENTAL_CURSORS_READ_FAILED",
      outcome: "warn",
      meta: { reason: describeError(err) },
    });
  }
  try {
    const lists = await fetchConversationList({ apiClient, buildUrl, diagnostics });
    for (const conv of lists.conversations) {
      if (!conversations.has(conv.id)) conversations.set(conv.id, conv.type);
    }
    // Refresh contacts + channels from the same payload so the local
    // sidebar tables stay in sync with the server (Req 1.1, Req 4.3).
    // Failures here are warn-level: incremental scan still runs against
    // whatever cursors / lists we already have.
    if (typeof repository.applyContacts === "function") {
      try {
        const r = await repository.applyContacts(lists.contactsRaw);
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_CONTACTS_APPLIED",
          outcome: "ok",
          meta: {
            received: lists.contactsRaw.length,
            upserted: r.upserted,
            ignored: r.ignored,
          },
        });
      } catch (err) {
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_CONTACTS_APPLY_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }
    if (typeof repository.applyChannels === "function") {
      try {
        const r = await repository.applyChannels(lists.channelsRaw);
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_CHANNELS_APPLIED",
          outcome: "ok",
          meta: {
            received: lists.channelsRaw.length,
            upserted: r.upserted,
            ignored: r.ignored,
          },
        });
      } catch (err) {
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_CHANNELS_APPLY_FAILED",
          outcome: "warn",
          meta: { reason: describeError(err) },
        });
      }
    }
  } catch (err) {
    diagnostics.log({
      category: "incremental",
      code: "INCREMENTAL_LIST_FETCH_FAILED",
      outcome: "warn",
      meta: { reason: describeError(err) },
    });
  }

  let scanned = 0;
  let batchesApplied = 0;
  let messagesApplied = 0;
  /** @type {string[]} */
  const failedIds = [];
  /** @type {Array<[string, "dm"|"channel"]>} */
  const ordered = [];
  conversations.forEach((type, id) => {
    ordered.push([id, type]);
  });
  for (const entry of ordered) {
    const id = entry[0];
    const type = entry[1];
    scanned += 1;
    const result = await runIncrementalConversation({
      conversation: { id, type },
      repository,
      apiClient,
      diagnostics,
      buildUrl,
      readCursors,
      inFlight,
      pageLimit,
      incrementalPageCap: pageCap,
      now,
    });
    batchesApplied += result.batchesApplied;
    messagesApplied += result.messagesApplied;
    if (!result.ok) failedIds.push(id);
  }

  const completedAtIso = new Date(now()).toISOString();
  if (scanned > 0 && failedIds.length < scanned) {
    // Persist the timestamp when at least one conversation made
    // progress. A pass where every conversation failed is still
    // recorded as `failed` and does not advance the meta key.
    await setLastIncrementalSyncAt(completedAtIso);
  }

  if (onPhaseChange) onPhaseChange("ready");
  const durationMs = now() - startedAt;
  diagnostics.log({
    category: "incremental",
    code: "INCREMENTAL_COMPLETE",
    outcome: failedIds.length === 0 ? "ok" : "warn",
    durationMs,
    meta: {
      conversationsScanned: scanned,
      batchesApplied,
      messagesApplied,
      failedCount: failedIds.length,
    },
  });

  return {
    ok: failedIds.length === 0,
    conversationsScanned: scanned,
    batchesApplied,
    messagesApplied,
    failedConversationIds: failedIds,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Unified incremental pass (Telegram-style single-endpoint sync)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UnifiedIncrementalOptions
 * @property {IncrementalRepository} repository
 * @property {IncrementalApiClient} apiClient
 * @property {IncrementalDiagnostics} diagnostics
 * @property {(pathOrUrl: string) => string} buildUrl
 * @property {string} lastSyncAt          ISO timestamp — the `since` cursor
 * @property {string | null} userId       Needed to derive DM conversationId
 * @property {(isoTimestamp: string) => Promise<void>} setLastIncrementalSyncAt
 * @property {number} [pageLimit]         Max messages per page (default 500)
 * @property {number} [incrementalPageCap] Max pages (default 50)
 * @property {() => number} [now]
 */

/**
 * @typedef {Object} UnifiedIncrementalResult
 * @property {boolean} ok
 * @property {number} messagesApplied
 * @property {number} batchesApplied       One batch per conversation group
 * @property {number} pagesConsumed
 * @property {number} durationMs
 */

/**
 * Run a single incremental pass using the unified updates endpoint.
 *
 * Instead of looping through every conversation and making N API calls,
 * this function makes ONE call to `GET /api/messages/updates?since=...`
 * and receives all new messages across all conversations in a single
 * response. It then groups them by `conversationId` and calls
 * `repository.applyServerMessages()` per group — the same write path the
 * per-conversation runner uses, so the SQLite schema and conflict
 * resolution logic are completely unchanged.
 *
 * Pagination: if the server returns `hasMore: true` (hit the 500-message
 * limit) the client advances `since` to `syncedUpTo` and fetches the
 * next page — capped at `incrementalPageCap` pages to prevent runaway
 * loops on a misbehaving server.
 *
 * Conversation ID derivation for DMs:
 *   The "conversation" with a DM peer is always identified by the peer's
 *   userId. For a message the local user SENT:  peer = receiver.
 *   For a message the local user RECEIVED:      peer = sender._id.
 *   Channel messages use `channelId` directly.
 *
 * @param {UnifiedIncrementalOptions} options
 * @returns {Promise<UnifiedIncrementalResult>}
 */
export async function runUnifiedIncremental(options) {
  if (options == null || options.repository == null) {
    throw new Error("runUnifiedIncremental: repository is required");
  }
  if (options.apiClient == null || typeof options.apiClient.get !== "function") {
    throw new Error("runUnifiedIncremental: apiClient.get is required");
  }
  if (typeof options.buildUrl !== "function") {
    throw new Error("runUnifiedIncremental: buildUrl is required");
  }
  if (typeof options.lastSyncAt !== "string" || options.lastSyncAt.length === 0) {
    throw new Error("runUnifiedIncremental: lastSyncAt (ISO string) is required");
  }
  if (typeof options.setLastIncrementalSyncAt !== "function") {
    throw new Error("runUnifiedIncremental: setLastIncrementalSyncAt is required");
  }

  const repository = options.repository;
  const diagnostics = options.diagnostics;
  const httpGet = makeHttpGet(options.apiClient, options.buildUrl);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const pageLimit =
    typeof options.pageLimit === "number" && options.pageLimit > 0
      ? Math.floor(options.pageLimit)
      : 500;
  const pageCap =
    typeof options.incrementalPageCap === "number" && options.incrementalPageCap > 0
      ? Math.floor(options.incrementalPageCap)
      : INCREMENTAL_PAGE_CAP;
  const userId = options.userId ?? null;

  const startedAt = now();
  let currentSince = options.lastSyncAt;
  let pagesConsumed = 0;
  let messagesApplied = 0;
  let batchesApplied = 0;

  diagnostics.log({
    category: "incremental",
    code: "UNIFIED_INCREMENTAL_STARTED",
    outcome: "ok",
    meta: { since: currentSince },
  });

  try {
    while (pagesConsumed < pageCap) {
      pagesConsumed += 1;
      const pageStartedAt = now();

      /** @type {{ messages: unknown[], hasMore: boolean, syncedUpTo: string } | null} */
      let data = null;
      try {
        data = await httpGet(SYNC_UPDATES_ROUTE, {
          since: currentSince,
          limit: pageLimit,
        });
      } catch (err) {
        diagnostics.log({
          category: "incremental",
          code: "UNIFIED_INCREMENTAL_FETCH_FAILED",
          outcome: "error",
          durationMs: now() - pageStartedAt,
          meta: { since: currentSince, reason: describeError(err) },
        });
        return {
          ok: false,
          messagesApplied,
          batchesApplied,
          pagesConsumed,
          durationMs: now() - startedAt,
        };
      }

      // Empty or malformed response — nothing new, we're caught up.
      if (
        data == null ||
        !Array.isArray(data.messages) ||
        data.messages.length === 0
      ) {
        break;
      }

      const messages = data.messages;

      // Group the flat array by conversationId.
      // For DMs the conversation peer is always the OTHER user:
      //   - message sent by local user   → receiver is the peer
      //   - message received by local user → sender._id is the peer
      // For channel messages the peer is the channelId itself.
      /** @type {Map<string, { type: "dm"|"channel", messages: unknown[] }>} */
      const byConversation = new Map();

      for (const msg of messages) {
        const raw = /** @type {any} */ (msg);
        const isChannel =
          raw.channelId != null && String(raw.channelId).length > 0;

        let conversationId;
        /** @type {"dm"|"channel"} */
        let conversationType;

        if (isChannel) {
          conversationId = String(raw.channelId);
          conversationType = "channel";
        } else {
          // Derive the peer: whoever is NOT the local user.
          const senderId =
            raw.sender != null && typeof raw.sender === "object"
              ? String(raw.sender._id ?? raw.sender)
              : String(raw.sender ?? "");
          const receiverId =
            raw.receiver != null && typeof raw.receiver === "object"
              ? String(raw.receiver._id ?? raw.receiver)
              : String(raw.receiver ?? "");

          // If userId is available use it for accurate derivation;
          // otherwise fall back to assuming sender is local user.
          if (userId != null && senderId === String(userId)) {
            conversationId = receiverId;
          } else if (userId != null && receiverId === String(userId)) {
            conversationId = senderId;
          } else {
            // Fallback (userId unknown): use receiverId as the peer
            // since the API already filtered to messages relevant to us.
            conversationId = receiverId || senderId;
          }
          conversationType = "dm";
        }

        if (!byConversation.has(conversationId)) {
          byConversation.set(conversationId, { type: conversationType, messages: [] });
        }
        byConversation.get(conversationId)?.messages.push(msg);
      }

      // Apply each group — same write path as the per-conversation runner.
      for (const [conversationId, { type, messages: convMessages }] of byConversation) {
        try {
          await repository.applyServerMessages({
            conversationId,
            conversationType: type,
            messages: convMessages,
            sourceCursor: { lastSyncedAt: new Date(now()).toISOString() },
          });
          batchesApplied += 1;
          messagesApplied += convMessages.length;
        } catch (err) {
          diagnostics.log({
            category: "incremental",
            code: "UNIFIED_INCREMENTAL_APPLY_FAILED",
            outcome: "warn",
            durationMs: now() - pageStartedAt,
            meta: { conversationId, reason: describeError(err) },
          });
          // Non-fatal: log and continue with the next conversation group.
        }
      }

      diagnostics.log({
        category: "incremental",
        code: "UNIFIED_INCREMENTAL_PAGE_OK",
        outcome: "ok",
        durationMs: now() - pageStartedAt,
        meta: {
          page: pagesConsumed,
          messagesInPage: messages.length,
          conversationsInPage: byConversation.size,
          hasMore: data.hasMore,
        },
      });

      // No more pages — we're fully caught up.
      if (!data.hasMore) break;

      // Advance the cursor for the next page.
      if (typeof data.syncedUpTo === "string" && data.syncedUpTo.length > 0) {
        currentSince = data.syncedUpTo;
      } else {
        // Defensive: if syncedUpTo is missing, stop paging to avoid
        // re-fetching the same page in a loop.
        break;
      }
    }

    // Persist the cursor so the next app-open resumes from here.
    const completedAt = new Date(now()).toISOString();
    await options.setLastIncrementalSyncAt(completedAt);

    const durationMs = now() - startedAt;
    diagnostics.log({
      category: "incremental",
      code: "UNIFIED_INCREMENTAL_COMPLETE",
      outcome: "ok",
      durationMs,
      meta: { messagesApplied, batchesApplied, pagesConsumed },
    });

    return { ok: true, messagesApplied, batchesApplied, pagesConsumed, durationMs };
  } catch (err) {
    diagnostics.log({
      category: "incremental",
      code: "UNIFIED_INCREMENTAL_UNHANDLED",
      outcome: "error",
      durationMs: now() - startedAt,
      meta: { reason: describeError(err) },
    });
    return {
      ok: false,
      messagesApplied,
      batchesApplied,
      pagesConsumed,
      durationMs: now() - startedAt,
    };
  }
}

