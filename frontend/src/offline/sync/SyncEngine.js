// @ts-check
/**
 * Sync_Engine — bootstrap, incremental, and live event reconciliation.
 *
 * Implements task 11.1 of the offline-support spec, validating
 * Requirements 4.1–4.6 and 5.1–5.8.
 *
 * The engine sits between the network (axios + socket.io) and the
 * repository. It owns three "phases":
 *
 *   - {@link bootstrap} — on first run for a user (the repository has no
 *     local data yet), fetch the contact list, the channel list, and one
 *     page of messages per conversation. Per-conversation failures retry
 *     up to 3 times with exponential backoff (2s/4s/8s ± 25% jitter)
 *     before being marked `partial`. Cross-conversation failures never
 *     stop the global pass. (Req 4.1, 4.2, 4.3, 4.4, 4.5, 4.6.)
 *   - {@link incremental} — on every connectivity transition to `online`
 *     and on every foreground transition. Reads each conversation's
 *     `sync_cursors` row (`last_created_at = T`), calls the matching
 *     endpoint with `?since=T&limit=200`, and pages until the response is
 *     short. The repository advances the cursor inside the same
 *     transaction that upserts the batch (Req 5.4); this engine never
 *     advances the cursor itself. A {@link PerConversationMutex} key
 *     keyed by `conversationId` enforces the "one in-flight per
 *     conversation" rule (Req 5.7). (Req 5.1, 5.2, 5.3, 5.4, 5.5, 5.6,
 *     5.7, 5.8.)
 *   - {@link applyLiveEvent} — translates the five socket events
 *     (`receiveMessage`, `receive-channel-message`, `messageSendFailed`,
 *     `message-deleted`, `message-status-update`) into repository
 *     calls. Resolves / rejects the `clientTempIdRegistry` deferred for
 *     the message-emit confirmation contract used by the OutboundQueue
 *     (§3.3 dispatch table + §3.4 confirmation flow).
 *
 * The factory is intentionally dependency-injected: tests construct a
 * stub `apiClient`, `repository`, `tempIdRegistry`, `diagnostics` and
 * drive the engine without ever booting Capacitor. The production
 * `OfflineProvider` (task 16.2) wires the real instances together.
 *
 * Design references:
 *   - §3.3 Sync_Engine (dispatch table, single-writer guarantee)
 *   - §3.5 Per-conversation mutex (Req 5.6 / 5.7)
 *   - §3.6 Conflict resolution (called via `repository.applyServerMessages`)
 *   - §Data Models / Schema v1 (`sync_cursors`, `meta`)
 *
 * @module offline/sync/SyncEngine
 */

import {
  HOST,
  DM_CONTACTS_ROUTE,
  GET_USER_CHANNELS_ROUTE,
  PRIVATE_CONTACT_MESSAGES_ROUTE,
  CHANNEL_MESSAGES_ROUTE,
} from "../../utils/constants.js";

import { getClientTempIdRegistry } from "./clientTempIdRegistry.js";
import { getDiagnostics } from "../utils/Diagnostics.js";
import { describeError, defaultSleep, asId } from "./syncHelpers.js";
import {
  runBootstrap,
  BOOTSTRAP_BACKOFF_MS as HELPER_BOOTSTRAP_BACKOFF_MS,
} from "./bootstrap.js";
import {
  runIncremental,
  runUnifiedIncremental,
  INCREMENTAL_PAGE_CAP as HELPER_INCREMENTAL_PAGE_CAP,
} from "./incremental.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default page size for both bootstrap and incremental fetches. The design
 * §3.3 calls out `limit=200` for incremental specifically; bootstrap uses
 * the same value so the per-conversation page is uniform.
 */
export const DEFAULT_PAGE_LIMIT = 200;

/**
 * Per-conversation bootstrap retry budget (Req 4.5). Three retries means
 * up to four attempts (initial + 3 retries) before the conversation is
 * marked `partial`.
 */
export const BOOTSTRAP_MAX_RETRIES = 3;

/**
 * Bootstrap backoff base — `2s`, `4s`, `8s` per §3.3 / Req 4.5. Each delay
 * is jittered ± 25% to avoid retry storms when many conversations fail
 * for the same reason (e.g. backend cold-start). Re-exported from
 * {@link ./bootstrap.js} so existing call sites that imported these
 * constants from `SyncEngine.js` keep working.
 */
export const BOOTSTRAP_BACKOFF_MS = HELPER_BOOTSTRAP_BACKOFF_MS;
export const BOOTSTRAP_JITTER_FRACTION = 0.25;

/**
 * Hard cap on incremental pages per conversation per call. Re-exported
 * from {@link ./incremental.js}; the value lives in the helper so the
 * helper can run standalone in tests.
 */
export const INCREMENTAL_PAGE_CAP = HELPER_INCREMENTAL_PAGE_CAP;

/**
 * @typedef {"idle"|"bootstrap"|"incremental"|"ready"|"degraded"} SyncPhase
 */

/**
 * @typedef {{ id: string, type: "dm"|"channel", unreadCount?: number }} ConversationRef
 */

/**
 * Subset of the repository surface the SyncEngine relies on. Matches the
 * public surface of `frontend/src/offline/repositories/index.js`.
 *
 * @typedef {Object} SyncRepository
 * @property {() => boolean} isReady
 * @property {(args: { conversationId: string, conversationType: "dm"|"channel", messages: unknown[], sourceCursor?: { lastServerId?: string, lastCreatedAt?: string, lastSyncedAt?: string } }) => Promise<{ inserted: number, updated: number, ignored: number }>} applyServerMessages
 * @property {(serverMessage: unknown) => Promise<void>} applyLiveMessage
 * @property {(args: { serverId: string, deletedForEveryone: boolean }) => Promise<void>} applyDeletion
 * @property {(args: { conversationId: string, fromUserId: string, status: string }) => Promise<void>} applyStatusUpdate
 * @property {(contacts: unknown[]) => Promise<{ upserted: number, ignored: number }>} [applyContacts]
 * @property {(channels: unknown[]) => Promise<{ upserted: number, ignored: number }>} [applyChannels]
 * @property {() => unknown} getDriver
 * @property {{ withLock: <T>(key: string, work: () => Promise<T> | T) => Promise<T> } | (() => { withLock: <T>(key: string, work: () => Promise<T> | T) => Promise<T> })} [getMutex]
 *   Optional accessor exposing the repository's `PerConversationMutex` so
 *   the engine can serialize incremental writes against live events for
 *   the same conversation without constructing a second mutex.
 */

/**
 * Subset of axios used by the engine. The `apiClient` may be a bare
 * `axios` import or an `axios.create(...)` instance — both expose the
 * same `get` shape. The engine consumes only `get`.
 *
 * @typedef {Object} SyncApiClient
 * @property {(url: string, opts?: { withCredentials?: boolean, params?: Record<string, unknown> }) => Promise<{ data?: unknown }>} get
 */

/**
 * Subset of {@link createClientTempIdRegistry} used by `applyLiveEvent`.
 *
 * @typedef {Object} SyncTempIdRegistry
 * @property {(clientTempId: string, payload: unknown) => boolean} resolve
 * @property {(clientTempId: string, error: Error | string) => boolean} reject
 */

/**
 * @typedef {Object} BootstrapResult
 * @property {boolean} ok
 * @property {number} conversationsTotal
 * @property {number} conversationsOk
 * @property {number} conversationsPartial
 * @property {string[]} partialConversationIds
 * @property {number} durationMs
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
 * Live-event envelope. The kind is the socket event name (the §3.3
 * dispatch table); the payload is the raw socket payload.
 *
 * @typedef {(
 *   | { kind: "receiveMessage", payload: Record<string, unknown> }
 *   | { kind: "receive-channel-message", payload: Record<string, unknown> }
 *   | { kind: "messageSendFailed", payload: Record<string, unknown> }
 *   | { kind: "message-deleted", payload: Record<string, unknown> }
 *   | { kind: "message-status-update", payload: Record<string, unknown> }
 * )} LiveEvent
 */

/**
 * @typedef {Object} SyncStatus
 * @property {SyncPhase} phase
 * @property {string|null} lastIncrementalSyncAt
 * @property {"none"|"partial"|"ok"} bootstrapStatus
 */

/**
 * @typedef {Object} CreateSyncEngineOptions
 * @property {SyncRepository} repository
 * @property {SyncApiClient} apiClient
 * @property {SyncTempIdRegistry} [tempIdRegistry]
 *   Defaults to {@link getClientTempIdRegistry}.
 * @property {{ log: (e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void }} [diagnostics]
 *   Defaults to {@link getDiagnostics}.
 * @property {string} [host]
 *   Backend host prefix prepended to relative paths. Defaults to the
 *   `HOST` constant from `frontend/src/utils/constants.js`. Tests pass
 *   an empty string so the apiClient stub sees the path verbatim.
 * @property {number} [pageLimit]
 *   Incremental / bootstrap page size. Defaults to {@link DEFAULT_PAGE_LIMIT}.
 * @property {number[]} [bootstrapBackoffMs]
 *   Override the bootstrap backoff schedule. Defaults to
 *   {@link BOOTSTRAP_BACKOFF_MS}. The length defines the retry budget
 *   (Req 4.5).
 * @property {() => number} [now]
 * @property {() => number} [random]
 *   Override `Math.random()` for deterministic jitter in tests.
 * @property {(ms: number) => Promise<void>} [sleep]
 *   Override the backoff sleep helper. Defaults to a `setTimeout`-based
 *   wrapper. Tests pass a no-op so retries run synchronously.
 * @property {number} [incrementalPageCap]
 *   Cap on pages-per-conversation per `incremental()` call. Defaults
 *   to {@link INCREMENTAL_PAGE_CAP}.
 */

/**
 * @typedef {Object} SyncEngine
 * @property {(opts: { userId: string }) => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {() => Promise<BootstrapResult>} bootstrap
 * @property {() => Promise<IncrementalResult>} incremental
 * @property {(event: LiveEvent) => Promise<void>} applyLiveEvent
 * @property {(state: "online"|"offline"|"reconnecting") => void} onConnectivityChange
 * @property {() => Promise<void>} onForegroundResume
 * @property {() => SyncStatus} getStatus
 * @property {(args: { conversationId: string, conversationType: "dm"|"channel" }) => Promise<{ ok: boolean, batchesApplied: number, messagesApplied: number }>} refreshConversation
 */

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh SyncEngine instance.
 *
 * @param {CreateSyncEngineOptions} options
 * @returns {SyncEngine}
 */
export function createSyncEngine(options) {
  if (options == null || options.repository == null) {
    throw new Error("createSyncEngine: repository is required");
  }
  if (options.apiClient == null || typeof options.apiClient.get !== "function") {
    throw new Error("createSyncEngine: apiClient.get is required");
  }
  const repository = options.repository;
  const apiClient = options.apiClient;
  const tempIdRegistry =
    options.tempIdRegistry != null
      ? options.tempIdRegistry
      : getClientTempIdRegistry();
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const host = typeof options.host === "string" ? options.host : HOST;
  const pageLimit =
    typeof options.pageLimit === "number" && options.pageLimit > 0
      ? Math.floor(options.pageLimit)
      : DEFAULT_PAGE_LIMIT;
  const bootstrapBackoffMs =
    Array.isArray(options.bootstrapBackoffMs) && options.bootstrapBackoffMs.length > 0
      ? options.bootstrapBackoffMs.slice()
      : BOOTSTRAP_BACKOFF_MS.slice();
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random =
    typeof options.random === "function" ? options.random : () => Math.random();
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const incrementalPageCap =
    typeof options.incrementalPageCap === "number" && options.incrementalPageCap > 0
      ? Math.floor(options.incrementalPageCap)
      : INCREMENTAL_PAGE_CAP;

  // ----- Mutable state ---------------------------------------------------

  /** @type {string | null} */
  let userId = null;
  /** @type {SyncPhase} */
  let phase = "idle";
  /** @type {string | null} */
  let lastIncrementalSyncAt = null;
  /** @type {"none"|"partial"|"ok"} */
  let bootstrapStatus = "none";
  /** @type {"online"|"offline"|"reconnecting"} */
  let connectivity = "online";
  /** @type {Promise<BootstrapResult> | null} */
  let bootstrapInFlight = null;
  /**
   * Per-conversation incremental in-flight tracker. Req 5.7 says we must
   * not run two `Incremental_Sync` passes for the same conversation
   * concurrently — this map records the active promise so a second call
   * for the same conversation simply awaits the existing one.
   *
   * @type {Map<string, Promise<{ ok: boolean, batchesApplied: number, messagesApplied: number }>>}
   */
  const incrementalInFlight = new Map();

  // ----- HTTP helpers ----------------------------------------------------

  /**
   * Build a backend URL from a relative path. The constants module exposes
   * paths like `/api/users/dm-contacts` (no host) and full URLs like
   * `${HOST}/api/channels`. This helper accepts either form: when the
   * input already starts with `http`, it is returned verbatim; otherwise
   * `host` is prepended.
   *
   * @param {string} pathOrUrl
   * @returns {string}
   */
  function buildUrl(pathOrUrl) {
    if (typeof pathOrUrl !== "string" || pathOrUrl.length === 0) return pathOrUrl;
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${host}${pathOrUrl}`;
  }

  /**
   * @template T
   * @param {string} pathOrUrl
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<T>}
   */
  async function httpGet(pathOrUrl, params) {
    const url = buildUrl(pathOrUrl);
    const opts = { withCredentials: true };
    if (params != null && Object.keys(params).length > 0) {
      /** @type {Record<string, unknown>} */ (opts).params = params;
    }
    const response = await apiClient.get(url, opts);
    return /** @type {T} */ (response != null ? response.data : undefined);
  }

  // ----- Cursor helpers --------------------------------------------------

  /**
   * Read `(conversationId, conversationType)` rows from `sync_cursors`. The
   * repository advances cursors atomically inside `applyServerMessages`, so
   * the engine only ever READS this table — never writes it directly.
   *
   * @returns {Promise<Map<string, { type: "dm"|"channel", lastUpdatedAt: string | null, lastServerId: string | null }>>}
   */
  async function readCursors() {
    const driver = /** @type {{ query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]> }} */ (
      repository.getDriver()
    );
    const rows = await driver.query(
      "SELECT conversation_id, conversation_type, last_updated_at, last_server_id FROM sync_cursors",
    );
    /** @type {Map<string, { type: "dm"|"channel", lastUpdatedAt: string | null, lastServerId: string | null }>} */
    const out = new Map();
    if (!Array.isArray(rows)) return out;
    for (const row of rows) {
      const id =
        typeof row.conversation_id === "string" && row.conversation_id.length > 0
          ? row.conversation_id
          : null;
      if (id == null) continue;
      const type = row.conversation_type === "channel" ? "channel" : "dm";
      const lastUpdatedAt =
        typeof row.last_updated_at === "string" && row.last_updated_at.length > 0
          ? row.last_updated_at
          : null;
      const lastServerId =
        typeof row.last_server_id === "string" && row.last_server_id.length > 0
          ? row.last_server_id
          : null;
      out.set(id, { type, lastUpdatedAt, lastServerId });
    }
    return out;
  }

  /**
   * Persist `meta.last_incremental_sync_at` after a successful
   * `incremental()` pass. Per Req 5.8 we record the timestamp only when
   * the pass completes without unhandled errors; partial failures (some
   * conversations failed) still record the timestamp because the
   * conversations that did succeed advanced their cursors.
   *
   * @param {string} isoTimestamp
   */
  async function setLastIncrementalSyncAt(isoTimestamp) {
    const driver = /** @type {{ run: (sql: string, values?: unknown[]) => Promise<{ changes: number }> }} */ (
      repository.getDriver()
    );
    try {
      await driver.run(
        "INSERT INTO meta (key, value) VALUES ('last_incremental_sync_at', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [isoTimestamp],
      );
      lastIncrementalSyncAt = isoTimestamp;
    } catch (err) {
      diagnostics.log({
        category: "incremental",
        code: "INCREMENTAL_META_WRITE_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }
  }

  // ----- Bootstrap -------------------------------------------------------

  /**
   * Compute the jittered delay for `attempt` (1-indexed: the first retry
   * is `attempt = 1`). Returns `0` when the schedule is exhausted.
   *
   * @param {number} attempt
   * @returns {number}
   */
  function bootstrapBackoff(attempt) {
    if (attempt < 1 || attempt > bootstrapBackoffMs.length) return 0;
    const base = bootstrapBackoffMs[attempt - 1];
    const jitter = base * BOOTSTRAP_JITTER_FRACTION * (random() * 2 - 1);
    return Math.max(0, Math.floor(base + jitter));
  }

  /**
   * Fetch the current user's DM contact list and channel list, then return
   * the unified set of conversations to bootstrap. Failures here propagate
   * as a global bootstrap failure (Req 4.3 — without contacts/channels
   * there is nothing to fetch).
   *
   * @returns {Promise<{ conversations: ConversationRef[], contactsRaw: any[], channelsRaw: any[] }>}
   */
  async function fetchConversationList() {
    /** @type {any[]} */
    let contactsRaw = [];
    /** @type {any[]} */
    let channelsRaw = [];
    try {
      const data = await httpGet(DM_CONTACTS_ROUTE);
      if (Array.isArray(data)) contactsRaw = data;
    } catch (err) {
      diagnostics.log({
        category: "bootstrap",
        code: "BOOTSTRAP_DM_CONTACTS_FAILED",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
      throw err;
    }
    try {
      const data = await httpGet(GET_USER_CHANNELS_ROUTE);
      if (Array.isArray(data)) channelsRaw = data;
    } catch (err) {
      diagnostics.log({
        category: "bootstrap",
        code: "BOOTSTRAP_CHANNELS_FAILED",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
      throw err;
    }

    /** @type {ConversationRef[]} */
    const conversations = [];
    for (const c of contactsRaw) {
      const id = asId(c);
      if (id != null) {
        conversations.push({
          id,
          type: "dm",
          unreadCount: typeof c.unreadCount === "number" ? c.unreadCount : 0,
        });
      }
    }
    for (const ch of channelsRaw) {
      const id = asId(ch);
      if (id != null) {
        conversations.push({
          id,
          type: "channel",
          unreadCount: typeof ch.unreadCount === "number" ? ch.unreadCount : 0,
        });
      }
    }
    return { conversations, contactsRaw, channelsRaw };
  }

  /**
   * Fetch one page of messages for a conversation. Bootstrap omits
   * `since` so the backend serves the most-recent page in legacy
   * descending order; the response is reversed to ascending so it can be
   * fed straight into `applyServerMessages` (the resolver does not care,
   * but ascending order is the convention `incremental()` uses).
   *
   * @param {ConversationRef} conv
   * @returns {Promise<unknown[]>}
   */
  async function fetchBootstrapPage(conv) {
    const route =
      conv.type === "dm" ? PRIVATE_CONTACT_MESSAGES_ROUTE : CHANNEL_MESSAGES_ROUTE;
    const data = await httpGet(`${route}/${conv.id}`, { limit: pageLimit });
    if (!Array.isArray(data)) return [];
    return data;
  }

  /**
   * Drive a single conversation's bootstrap with retry + backoff (Req 4.5).
   *
   * @param {ConversationRef} conv
   * @returns {Promise<{ ok: boolean, partial: boolean, attempts: number }>}
   */
  async function bootstrapConversation(conv) {
    /** @type {Error | null} */
    let lastErr = null;
    const totalAttempts = bootstrapBackoffMs.length + 1;
    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      const phaseStart = now();
      try {
        const messages = await fetchBootstrapPage(conv);
        await repository.applyServerMessages({
          conversationId: conv.id,
          conversationType: conv.type,
          messages,
        });
        diagnostics.log({
          category: "bootstrap",
          code: "BOOTSTRAP_CONVERSATION_OK",
          outcome: "ok",
          durationMs: now() - phaseStart,
          meta: {
            conversationId: conv.id,
            conversationType: conv.type,
            messages: messages.length,
            attempts: attempt + 1,
          },
        });
        return { ok: true, partial: false, attempts: attempt + 1 };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(describeError(err));
        diagnostics.log({
          category: "bootstrap",
          code: "BOOTSTRAP_CONVERSATION_RETRY",
          outcome: "warn",
          durationMs: now() - phaseStart,
          meta: {
            conversationId: conv.id,
            conversationType: conv.type,
            attempt: attempt + 1,
            reason: describeError(err),
          },
        });
        if (attempt < bootstrapBackoffMs.length) {
          await sleep(bootstrapBackoff(attempt + 1));
        }
      }
    }
    diagnostics.log({
      category: "bootstrap",
      code: "BOOTSTRAP_CONVERSATION_PARTIAL",
      outcome: "error",
      meta: {
        conversationId: conv.id,
        conversationType: conv.type,
        reason: lastErr != null ? lastErr.message : "unknown",
      },
    });
    return { ok: false, partial: true, attempts: totalAttempts };
  }

  /**
   * @returns {Promise<BootstrapResult>}
   */
  async function bootstrap() {
    if (bootstrapInFlight != null) return bootstrapInFlight;

    bootstrapInFlight = (async () => {
      const startedAt = now();
      phase = "bootstrap";
      diagnostics.log({
        category: "bootstrap",
        code: "BOOTSTRAP_STARTED",
        outcome: "ok",
        meta: { userId },
      });

      let conversations = [];
      let contactsRaw = [];
      let channelsRaw = [];
      try {
        const lists = await fetchConversationList();
        conversations = lists.conversations;
        conversations.sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0));
        contactsRaw = lists.contactsRaw;
        channelsRaw = lists.channelsRaw;
      } catch (err) {
        phase = "degraded";
        bootstrapStatus = "partial";
        diagnostics.log({
          category: "bootstrap",
          code: "BOOTSTRAP_LIST_FETCH_FAILED",
          outcome: "error",
          durationMs: now() - startedAt,
          meta: { reason: describeError(err) },
        });
        return {
          ok: false,
          conversationsTotal: 0,
          conversationsOk: 0,
          conversationsPartial: 0,
          partialConversationIds: [],
          durationMs: now() - startedAt,
        };
      }

      // Persist the contact + channel lists so the UI's `getContacts()` /
      // `getChannels()` reads survive an offline restart (Req 1.1, 4.3).
      // Failures here are non-fatal: per-conversation message fetches
      // still proceed and the next incremental pass will retry the upsert.
      if (typeof repository.applyContacts === "function") {
        try {
          const r = await repository.applyContacts(contactsRaw);
          diagnostics.log({
            category: "bootstrap",
            code: "BOOTSTRAP_CONTACTS_APPLIED",
            outcome: "ok",
            meta: {
              received: contactsRaw.length,
              upserted: r.upserted,
              ignored: r.ignored,
            },
          });
        } catch (err) {
          diagnostics.log({
            category: "bootstrap",
            code: "BOOTSTRAP_CONTACTS_APPLY_FAILED",
            outcome: "warn",
            meta: { reason: describeError(err) },
          });
        }
      }
      if (typeof repository.applyChannels === "function") {
        try {
          const r = await repository.applyChannels(channelsRaw);
          diagnostics.log({
            category: "bootstrap",
            code: "BOOTSTRAP_CHANNELS_APPLIED",
            outcome: "ok",
            meta: {
              received: channelsRaw.length,
              upserted: r.upserted,
              ignored: r.ignored,
            },
          });
        } catch (err) {
          diagnostics.log({
            category: "bootstrap",
            code: "BOOTSTRAP_CHANNELS_APPLY_FAILED",
            outcome: "warn",
            meta: { reason: describeError(err) },
          });
        }
      }

      let okCount = 0;
      let partialCount = 0;
      /** @type {string[]} */
      const partialIds = [];
      for (const conv of conversations) {
        const result = await bootstrapConversation(conv);
        if (result.ok) {
          okCount += 1;
        } else {
          partialCount += 1;
          partialIds.push(conv.id);
        }
      }

      // Req 4.6: set global status to `ready` after all conversations
      // finish, even when some are partial — partial conversations do
      // not block the rest of the app from coming online.
      phase = "ready";
      bootstrapStatus = partialCount === 0 ? "ok" : "partial";
      const durationMs = now() - startedAt;

      // Persist `meta.bootstrap_completed_at` once at least one
      // conversation succeeds. `shouldBootstrap()` reads this on
      // subsequent boots to differentiate "never bootstrapped" from
      // "bootstrap finished, just resume incremental".
      if (okCount > 0) {
        try {
          const drv = /** @type {{ run: (sql: string, values?: unknown[]) => Promise<unknown> }} */ (
            repository.getDriver()
          );
          if (drv != null && typeof drv.run === "function") {
            await drv.run(
              "INSERT INTO meta (key, value) VALUES ('bootstrap_completed_at', ?) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
              [new Date(now()).toISOString()],
            );
          }
        } catch (err) {
          diagnostics.log({
            category: "bootstrap",
            code: "BOOTSTRAP_META_WRITE_FAILED",
            outcome: "warn",
            meta: { reason: describeError(err) },
          });
        }
      }

      diagnostics.log({
        category: "bootstrap",
        code: "BOOTSTRAP_COMPLETE",
        outcome: partialCount === 0 ? "ok" : "warn",
        durationMs,
        meta: {
          conversationsTotal: conversations.length,
          conversationsOk: okCount,
          conversationsPartial: partialCount,
        },
      });
      return {
        ok: true,
        conversationsTotal: conversations.length,
        conversationsOk: okCount,
        conversationsPartial: partialCount,
        partialConversationIds: partialIds,
        durationMs,
      };
    })();

    try {
      return await bootstrapInFlight;
    } finally {
      bootstrapInFlight = null;
    }
  }

  // ----- Incremental -----------------------------------------------------

  /**
   * Pull pages for a single conversation until the server returns a short
   * page. The repository advances `sync_cursors` inside its own
   * transaction (Req 5.4), so this loop just re-reads the cursor between
   * pages rather than tracking it locally.
   *
   * Single-in-flight per conversation (Req 5.7) is enforced by
   * {@link incrementalInFlight}: a second concurrent call for the same
   * id returns the existing promise instead of starting a fresh pass.
   * The cross-writer serialization of Req 5.6 is delegated to the
   * repository — every `applyServerMessages` call grabs the
   * conversation mutex internally, so a live event landing for the same
   * conversation while the page is being applied still serializes
   * correctly. Wrapping this loop in the same mutex would deadlock the
   * inner `applyServerMessages` call (the chained-promise mutex is not
   * re-entrant).
   *
   * @param {ConversationRef} conv
   * @returns {Promise<{ ok: boolean, batchesApplied: number, messagesApplied: number }>}
   */
  async function incrementalConversation(conv) {
    const existing = incrementalInFlight.get(conv.id);
    if (existing != null) return existing;

    const promise = (async () => {
      const route =
        conv.type === "dm"
          ? PRIVATE_CONTACT_MESSAGES_ROUTE
          : CHANNEL_MESSAGES_ROUTE;
      let batchesApplied = 0;
      let messagesApplied = 0;
      let pages = 0;
      try {
        while (pages < incrementalPageCap) {
          pages += 1;
          const cursors = await readCursors();
          const cursor = cursors.get(conv.id) || {
            type: conv.type,
            lastUpdatedAt: null,
            lastServerId: null,
          };
          /** @type {Record<string, unknown>} */
          const params = { limit: pageLimit };
          if (cursor.lastUpdatedAt != null) {
            params.since = cursor.lastUpdatedAt;
          }
          if (cursor.lastServerId != null) {
            params.lastId = cursor.lastServerId;
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
            // (i.e. a brand-new conversation) is fine — the repository's
            // `applyServerMessages` short-circuits on empty input and
            // does not touch the cursor.
            break;
          }

          // Without a since cursor the backend's legacy code path returns
          // newest-first. With a since cursor it returns ascending — the
          // shape `applyServerMessages` expects. Convert the legacy shape
          // into ascending order so the conflict resolver always sees
          // ascending input.
          if (cursor.lastUpdatedAt == null) {
            page = page.slice().reverse();
          }

          /** @type {{ lastServerId?: string, lastUpdatedAt?: string, lastSyncedAt?: string }} */
          const sourceCursor = {
            lastSyncedAt: new Date(now()).toISOString(),
          };
          if (cursor.lastUpdatedAt != null) sourceCursor.lastUpdatedAt = cursor.lastUpdatedAt;
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
        incrementalInFlight.delete(conv.id);
      }
    })();

    incrementalInFlight.set(conv.id, promise);
    return promise;
  }

  /**
   * @returns {Promise<IncrementalResult>}
   */
  async function incremental() {
    phase = "incremental";

    // -----------------------------------------------------------------------
    // Unified feed path (Telegram-style — one API call for all conversations)
    // -----------------------------------------------------------------------
    // After the first bootstrap we always have a `lastIncrementalSyncAt`
    // cursor. When that cursor exists we use the unified endpoint:
    //   GET /api/messages/updates?since=<cursor>
    // which returns ALL new messages across ALL conversations in a single
    // round trip. The per-conversation N-call path below is kept as a
    // fallback for edge cases (no cursor, or unified endpoint unavailable).
    //
    // Why this fixes the chat-open UX:
    //   N calls (old): each conversation syncs ~200ms apart — the user can
    //     tap a chat before that conversation's call completes, sees stale
    //     data, then sees a late scroll jank when the call finishes.
    //   1 call (new): all conversations synced in ~200ms total — by the
    //     time the sidebar shows unread badges (driven by subscribeContacts
    //     firing after the SQLite write), the messages are already there.
    if (lastIncrementalSyncAt != null) {
      // Step 1: unified message fetch — one call for everything.
      // We do this BEFORE the contacts/channels fetch so that all new messages
      // are written to SQLite before the sidebar updates its unread counts.
      // That way, if the user immediately opens a chat, the messages are already there.
      const result = await runUnifiedIncremental({
        repository,
        apiClient,
        diagnostics,
        buildUrl,
        lastSyncAt: lastIncrementalSyncAt,
        userId,
        setLastIncrementalSyncAt,
        pageLimit,
        incrementalPageCap,
        now,
      });

      // Step 2: refresh contacts + channels so the sidebar stays in sync.
      try {
        const lists = await fetchConversationList();
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

      phase = "ready";
      return {
        ok: result.ok,
        // Shape matches the old return type so callers (tests etc.) are unaffected.
        conversationsScanned: result.batchesApplied,
        batchesApplied: result.batchesApplied,
        messagesApplied: result.messagesApplied,
        failedConversationIds: result.ok ? [] : ["unified-fetch"],
        durationMs: result.durationMs,
      };
    }

    // -----------------------------------------------------------------------
    // Fallback: N-conversation loop (used on very first run, no cursor yet)
    // -----------------------------------------------------------------------
    const startedAt = now();
    diagnostics.log({
      category: "incremental",
      code: "INCREMENTAL_STARTED",
      outcome: "ok",
      meta: { userId },
    });

    /** @type {Map<string, { type: "dm"|"channel", unreadCount: number }>} */
    const conversations = new Map();
    try {
      const cursors = await readCursors();
      cursors.forEach((c, id) => {
        conversations.set(id, { type: c.type, unreadCount: 0 });
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
      const lists = await fetchConversationList();
      for (const conv of lists.conversations) {
        conversations.set(conv.id, {
          type: conv.type,
          unreadCount: conv.unreadCount || 0,
        });
      }
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
    /** @type {Array<{ id: string, type: "dm"|"channel", unreadCount: number }>} */
    const ordered = [];
    conversations.forEach((info, id) => {
      ordered.push({ id, type: info.type, unreadCount: info.unreadCount });
    });
    ordered.sort((a, b) => b.unreadCount - a.unreadCount);

    for (const entry of ordered) {
      const id = entry.id;
      const type = entry.type;
      scanned += 1;
      const result = await incrementalConversation({ id, type });
      batchesApplied += result.batchesApplied;
      messagesApplied += result.messagesApplied;
      if (!result.ok) failedIds.push(id);
    }

    const completedAtIso = new Date(now()).toISOString();
    if (scanned > 0 && failedIds.length < scanned) {
      await setLastIncrementalSyncAt(completedAtIso);
    }

    phase = "ready";
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

  // ----- Live event dispatch (§3.3 + clientTempId resolve/reject) --------

  /**
   * Dispatch a single socket event to the repository per the §3.3 table.
   *
   * The dispatch table (per task prompt + §3.3):
   *
   *   | kind                       | action                                                 |
   *   | receiveMessage             | applyLiveMessage(payload); if clientTempId, registry.resolve |
   *   | receive-channel-message    | applyLiveMessage(payload); if clientTempId, registry.resolve |
   *   | messageSendFailed          | registry.reject(clientTempId, error)                   |
   *   | message-deleted            | applyDeletion({ serverId, deletedForEveryone: true })  |
   *   | message-status-update      | applyStatusUpdate({ conversationId, fromUserId, status }) |
   *
   * The repository's write methods are themselves serialized via the
   * per-conversation mutex (§3.5), so this dispatch does not need to
   * grab a lock — Req 5.6 / 9.7 are satisfied at the repository layer.
   *
   * @param {LiveEvent} event
   * @returns {Promise<void>}
   */
  async function applyLiveEvent(event) {
    if (event == null || typeof event !== "object") return;
    const kind = /** @type {string} */ (event.kind);
    const payload =
      event.payload != null && typeof event.payload === "object"
        ? /** @type {Record<string, unknown>} */ (event.payload)
        : {};
    const startedAt = now();
    try {
      switch (kind) {
        case "receiveMessage":
        case "receive-channel-message": {
          await repository.applyLiveMessage(payload);
          const clientTempId =
            typeof payload.clientTempId === "string" && payload.clientTempId.length > 0
              ? payload.clientTempId
              : null;
          if (clientTempId != null) {
            tempIdRegistry.resolve(clientTempId, payload);
          }
          diagnostics.log({
            category: "live",
            code: kind === "receiveMessage" ? "LIVE_DM_APPLIED" : "LIVE_CHANNEL_APPLIED",
            outcome: "ok",
            durationMs: now() - startedAt,
            meta: { hasClientTempId: clientTempId != null },
          });
          return;
        }

        case "new-channel-contact": {
          if (typeof repository.applyChannels === "function") {
            await repository.applyChannels([payload]);
          }
          diagnostics.log({
            category: "live",
            code: "LIVE_CHANNEL_CONTACT_APPLIED",
            outcome: "ok",
          });
          return;
        }

        case "messageSendFailed": {
          const clientTempId =
            typeof payload.clientTempId === "string" && payload.clientTempId.length > 0
              ? payload.clientTempId
              : null;
          const errorMessage =
            typeof payload.error === "string" && payload.error.length > 0
              ? payload.error
              : "MESSAGE_SEND_FAILED";
          if (clientTempId != null) {
            tempIdRegistry.reject(clientTempId, new Error(errorMessage));
          }
          diagnostics.log({
            category: "live",
            code: "LIVE_MESSAGE_SEND_FAILED",
            outcome: "warn",
            durationMs: now() - startedAt,
            meta: {
              hasClientTempId: clientTempId != null,
              reason: errorMessage,
            },
          });
          return;
        }

        case "message-deleted": {
          const serverId =
            typeof payload.messageId === "string" && payload.messageId.length > 0
              ? payload.messageId
              : typeof payload.serverId === "string" && payload.serverId.length > 0
                ? payload.serverId
                : typeof payload._id === "string" && payload._id.length > 0
                  ? payload._id
                  : null;
          if (serverId == null) {
            diagnostics.log({
              category: "live",
              code: "LIVE_DELETION_DROPPED",
              outcome: "warn",
              durationMs: now() - startedAt,
              meta: { reason: "missing serverId" },
            });
            return;
          }
          await repository.applyDeletion({
            serverId,
            deletedForEveryone: true,
          });
          diagnostics.log({
            category: "live",
            code: "LIVE_DELETION_APPLIED",
            outcome: "ok",
            durationMs: now() - startedAt,
            meta: { serverId },
          });
          return;
        }

        case "message-status-update": {
          // The §3.3 table calls out
          // `applyStatusUpdate({ conversationId: receiverId, fromUserId, status })`.
          // The backend emits `{ senderId, receiverId, status }`. From the
          // local user's perspective, the conversation is the OTHER party
          // — that is `senderId` when the local user is the receiver, and
          // `receiverId` when the local user is the sender. Both viewpoints
          // converge on the OTHER party for a DM.
          const status =
            typeof payload.status === "string" ? payload.status : null;
          const senderId =
            typeof payload.senderId === "string" && payload.senderId.length > 0
              ? payload.senderId
              : null;
          const receiverId =
            typeof payload.receiverId === "string" && payload.receiverId.length > 0
              ? payload.receiverId
              : null;
          if (status == null || senderId == null) {
            diagnostics.log({
              category: "live",
              code: "LIVE_STATUS_UPDATE_DROPPED",
              outcome: "warn",
              durationMs: now() - startedAt,
              meta: { reason: "missing senderId or status" },
            });
            return;
          }
          // `fromUserId` is the user who SENT the message whose status
          // we're updating — that is `senderId` from the backend
          // payload.
          const fromUserId = senderId;
          // `conversationId` is the OTHER party from the local user's
          // viewpoint. When `userId` is bound (post-`start`), use it to
          // pick the right peer; otherwise fall back to `receiverId`
          // (the most common case, since the backend emits the update
          // to the message's sender — i.e. the local user when the
          // status moves to `delivered` / `read`).
          let conversationId;
          if (userId != null && receiverId != null && senderId != null) {
            conversationId = senderId === userId ? receiverId : senderId;
          } else if (receiverId != null && senderId != null) {
            conversationId = receiverId;
          } else {
            conversationId = receiverId || senderId;
          }
          await repository.applyStatusUpdate({
            conversationId,
            fromUserId,
            status,
          });
          diagnostics.log({
            category: "live",
            code: "LIVE_STATUS_UPDATE_APPLIED",
            outcome: "ok",
            durationMs: now() - startedAt,
            meta: { conversationId, fromUserId, status },
          });
          return;
        }

        default: {
          diagnostics.log({
            category: "live",
            code: "LIVE_UNKNOWN_KIND",
            outcome: "warn",
            durationMs: now() - startedAt,
            meta: { kind },
          });
          return;
        }
      }
    } catch (err) {
      diagnostics.log({
        category: "live",
        code: "LIVE_DISPATCH_FAILED",
        outcome: "error",
        durationMs: now() - startedAt,
        meta: { kind, reason: describeError(err) },
      });
    }
  }

  // ----- Lifecycle -------------------------------------------------------

  /**
   * Read the persisted `meta.last_incremental_sync_at` so a fresh
   * `start()` after a process restart preserves the timestamp the UI
   * shows (and so {@link getStatus} returns the right value before the
   * first incremental pass runs).
   */
  async function hydrateLastIncrementalSyncAt() {
    try {
      const driver = /** @type {{ query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]> }} */ (
        repository.getDriver()
      );
      const rows = await driver.query(
        "SELECT value FROM meta WHERE key = 'last_incremental_sync_at' LIMIT 1",
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const v = rows[0]?.value;
        if (typeof v === "string" && v.length > 0) lastIncrementalSyncAt = v;
      }
    } catch {
      // First-run: the meta row may not exist yet. Leave the field null.
    }
  }

  /**
   * Decide whether the engine needs to bootstrap (first run for this
   * user) or just incremental-sync (we already have data).
   *
   * Two signals — both must say "we are caught up" for us to skip the
   * bootstrap path:
   *
   *   1. `meta.bootstrap_completed_at` is set. The bootstrap helper writes
   *      this on a successful pass. Its absence means we have never
   *      finished a bootstrap for this user, even if some incidental
   *      cursor rows exist (e.g. from a previous partial run, or from
   *      messages that arrived live before the bootstrap had a chance
   *      to run).
   *   2. `sync_cursors` is non-empty. Defensive against a
   *      `bootstrap_completed_at` row that survived a `meta`-only
   *      cleanup.
   *
   * Either signal missing → re-bootstrap. This is the fix for the
   * "stuck partial state" bug: previously, any cursor row at all caused
   * us to skip bootstrap, so the contacts / channels tables stayed
   * empty forever after a single partial run.
   *
   * @returns {Promise<boolean>}
   */
  async function shouldBootstrap() {
    try {
      const cursors = await readCursors();
      if (cursors.size === 0) return true;

      const driver = /** @type {{ query: (sql: string, values?: unknown[]) => Promise<{ value?: unknown }[]> }} */ (
        repository.getDriver()
      );
      const rows = await driver.query(
        "SELECT value FROM meta WHERE key = 'bootstrap_completed_at' LIMIT 1",
      );
      if (!Array.isArray(rows) || rows.length === 0) return true;
      const v = rows[0]?.value;
      if (v == null || String(v).length === 0) return true;
      return false;
    } catch {
      // If the read fails we err on the side of bootstrap — better to
      // re-fetch than to silently skip the initial pass.
      return true;
    }
  }

  /**
   * @param {{ userId: string }} args
   */
  async function start(args) {
    if (args == null || typeof args.userId !== "string" || args.userId.length === 0) {
      throw new Error("SyncEngine.start: userId is required");
    }
    userId = args.userId;
    if (!repository.isReady()) {
      diagnostics.log({
        category: "boot",
        code: "SYNC_ENGINE_REPOSITORY_NOT_READY",
        outcome: "warn",
        meta: { userId },
      });
      phase = "degraded";
      return;
    }
    await hydrateLastIncrementalSyncAt();
    phase = "ready";
    diagnostics.log({
      category: "boot",
      code: "SYNC_ENGINE_STARTED",
      outcome: "ok",
      meta: { userId },
    });
    if (await shouldBootstrap()) {
      // Run bootstrap in the background so the UI does not block on the
      // initial sync — Req 4.2 ("expose a bootstrap status flag so the
      // UI can render a progress indicator without blocking"). On cold
      // boot the local DB is empty so there is no stale data to hide,
      // and a cold bootstrap can take 10+ seconds.
      void bootstrap().catch((err) => {
        diagnostics.log({
          category: "bootstrap",
          code: "BOOTSTRAP_UNHANDLED",
          outcome: "error",
          meta: { reason: describeError(err) },
        });
      });
    } else {
      // On a warm boot we already have data in the local DB (and the
      // sidebar hydrates from it in `OfflineProvider.boot` before
      // `start()` runs). Block the `start()` promise on incremental
      // so the sidebar reads, message counts, and `last_message`
      // previews reflect the latest server state by the time the UI
      // becomes interactive. Without this, the sidebar paints with
      // stale `unread_count` / `last_message` values and the user sees
      // the counts "drop" 1-2s later when the first incremental lands.
      // Errors are absorbed by the `.catch` so `start()` never rejects.
      await incremental().catch((err) => {
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_UNHANDLED",
          outcome: "error",
          meta: { reason: describeError(err) },
        });
      });
    }
  }

  /**
   * Stop the engine and clear any per-user state. In-flight bootstrap /
   * incremental promises are not cancelled — they finish naturally (the
   * repository writes are idempotent, so an in-flight commit completing
   * after `stop()` is harmless), but new calls observe the cleared
   * `userId` and the `idle` phase.
   */
  async function stop() {
    diagnostics.log({
      category: "boot",
      code: "SYNC_ENGINE_STOPPED",
      outcome: "ok",
      meta: { userId },
    });
    userId = null;
    phase = "idle";
    bootstrapStatus = "none";
    incrementalInFlight.clear();
  }

  /**
   * Shared catch-up path for connectivity `online` transitions and app
   * foreground resume. REST incremental sync is allowed while
   * `reconnecting` (network up, socket still handshaking); only true
   * `offline` is a no-op.
   *
   * @param {"connectivity"|"foreground"} trigger
   * @returns {Promise<void>}
   */
  async function runCatchUpSync(trigger) {
    if (userId == null || !repository.isReady()) return;
    if (connectivity === "offline") return;
    try {
      if (await shouldBootstrap()) {
        await bootstrap();
      } else {
        await incremental();
      }
    } catch (err) {
      diagnostics.log({
        category: "incremental",
        code:
          trigger === "foreground"
            ? "FOREGROUND_SYNC_FAILED"
            : "INCREMENTAL_TRIGGER_FAILED",
        outcome: "warn",
        meta: { reason: describeError(err) },
      });
    }
  }

  /**
   * React to connectivity transitions. The OutboundQueue (task 10.1) owns
   * its own draining trigger; this engine handles the sync side.
   *
   *   - `online` → run an incremental pass (Req 5.2 / Req 11.5). If we
   *     have not yet bootstrapped, run that instead.
   *   - `offline` → record the state for `getStatus`; no API calls.
   *   - `reconnecting` → record the state; an `online` transition will
   *     follow.
   *
   * Errors from the triggered pass are swallowed and logged — the engine
   * keeps a clean phase so the next transition can retry.
   *
   * @param {"online"|"offline"|"reconnecting"} state
   */
  function onConnectivityChange(state) {
    if (state !== "online" && state !== "offline" && state !== "reconnecting") {
      return;
    }
    const previous = connectivity;
    connectivity = state;
    if (state === "online" && previous !== "online" && userId != null && repository.isReady()) {
      void runCatchUpSync("connectivity");
    }
  }

  /**
   * Run incremental (or bootstrap) sync when the app returns to the
   * foreground. Called by {@link OfflineProvider} on Capacitor
   * `appStateChange` so backgrounded sessions catch up immediately on
   * resume without waiting for another connectivity edge.
   *
   * @returns {Promise<void>}
   */
  function onForegroundResume() {
    return runCatchUpSync("foreground");
  }

  /**
   * @returns {SyncStatus}
   */
  function getStatus() {
    return {
      phase,
      lastIncrementalSyncAt,
      bootstrapStatus,
    };
  }

  return {
    start,
    stop,
    bootstrap,
    incremental,
    applyLiveEvent,
    onConnectivityChange,
    onForegroundResume,
    getStatus,
    /**
     * Run an incremental sync for a single conversation. Used by the
     * UI on chat-open to top up the local cache with anything newer
     * than the cursor, so the user doesn't see a stale-then-fresh
     * flash when they were offline and now have unread messages.
     * Falls through to a no-op when the engine is idle / offline /
     * the repository isn't ready.
     *
     * @param {{ conversationId: string, conversationType: "dm"|"channel" }} args
     * @returns {Promise<{ ok: boolean, batchesApplied: number, messagesApplied: number }>}
     */
    refreshConversation: async (args) => {
      if (
        args == null ||
        typeof args.conversationId !== "string" ||
        args.conversationId.length === 0 ||
        (args.conversationType !== "dm" && args.conversationType !== "channel")
      ) {
        return { ok: false, batchesApplied: 0, messagesApplied: 0 };
      }
      if (!repository.isReady()) {
        return { ok: false, batchesApplied: 0, messagesApplied: 0 };
      }
      if (connectivity === "offline") {
        return { ok: false, batchesApplied: 0, messagesApplied: 0 };
      }
      try {
        return await incrementalConversation({
          id: args.conversationId,
          type: args.conversationType,
        });
      } catch (err) {
        diagnostics.log({
          category: "incremental",
          code: "INCREMENTAL_REFRESH_FAILED",
          outcome: "warn",
          meta: {
            conversationId: args.conversationId,
            reason: describeError(err),
          },
        });
        return { ok: false, batchesApplied: 0, messagesApplied: 0 };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton (deferred — wired by OfflineProvider in task 16.2)
// ---------------------------------------------------------------------------

/** @type {SyncEngine | null} */
let singleton = null;

/**
 * Process-wide engine. The OfflineProvider (task 16.2) wires the singleton
 * with the live `apiClient`, `repository`, and `tempIdRegistry`. Tests
 * should construct their own via {@link createSyncEngine}.
 *
 * @param {CreateSyncEngineOptions} [options]
 * @returns {SyncEngine}
 */
export function getSyncEngine(options) {
  if (singleton == null) {
    if (options == null) {
      throw new Error(
        "getSyncEngine: first call must supply options to construct the singleton",
      );
    }
    singleton = createSyncEngine(options);
  }
  return singleton;
}

/**
 * Reset the module-level singleton. Test-only.
 *
 * @internal
 */
export function __resetSyncEngineSingletonForTests() {
  singleton = null;
}
