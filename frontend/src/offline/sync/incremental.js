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
