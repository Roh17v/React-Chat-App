// @ts-check
/**
 * Bootstrap_Sync helper — the per-conversation runner that powers
 * {@link createSyncEngine}'s `bootstrap()` method.
 *
 * Implements task 11.2 of the offline-support spec, validating
 * Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6.
 *
 * The helper is intentionally stateless: every dependency (axios
 * `apiClient`, repository, diagnostics, sleep / random / now hooks,
 * backoff schedule) is injected by the caller. {@link createSyncEngine}
 * composes these helpers with its own mutable state (`phase`,
 * `bootstrapStatus`, `bootstrapInFlight`); the helper itself only
 * returns the {@link BootstrapResult}.
 *
 * Behavior preserved verbatim from the inline implementation that
 * landed in task 11.1:
 *
 *   - `GET /api/users/dm-contacts`   (Req 4.3)
 *   - `GET /api/channels`            (Req 4.3)
 *   - per conversation: `GET /api/messages/private/:id` or
 *     `GET /api/messages/channel/:id` (Req 4.3)
 *   - per-conversation 3-retry exponential backoff (2s/4s/8s ± 25%
 *     jitter) before marking the conversation `partial` (Req 4.5)
 *   - cross-conversation failures never stop the global pass — the
 *     pass returns `ok: true` even when some conversations are partial,
 *     because the rest of the conversations still succeeded (Req 4.6)
 *   - the repository advances `sync_cursors` inside its own
 *     `applyServerMessages` transaction (Req 4.4) — this helper does
 *     not touch cursors directly
 *
 * @module offline/sync/bootstrap
 */

import {
  DM_CONTACTS_ROUTE,
  GET_USER_CHANNELS_ROUTE,
  PRIVATE_CONTACT_MESSAGES_ROUTE,
  CHANNEL_MESSAGES_ROUTE,
} from "../../utils/constants.js";

import { describeError, asId, defaultSleep } from "./syncHelpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default page size for bootstrap fetches. Matches the incremental page
 * size so the very first page handed to the conflict resolver looks the
 * same as the steady-state page after the first incremental run.
 */
export const DEFAULT_PAGE_LIMIT = 200;

/**
 * Per-conversation bootstrap retry budget (Req 4.5). Three retries means
 * up to four attempts (initial + 3 retries) before the conversation is
 * marked `partial`.
 */
export const BOOTSTRAP_MAX_RETRIES = 3;

/**
 * Bootstrap backoff base — `2s`, `4s`, `8s` per §3.3 / Req 4.5. Each
 * delay is jittered ± 25% to avoid retry storms when many conversations
 * fail for the same reason (e.g. backend cold-start).
 */
export const BOOTSTRAP_BACKOFF_MS = [2_000, 4_000, 8_000];
export const BOOTSTRAP_JITTER_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, type: "dm"|"channel" }} ConversationRef
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
 * Subset of the repository surface this helper needs. Mirrors the
 * matching subset in {@link createSyncEngine}.
 *
 * @typedef {Object} BootstrapRepository
 * @property {(args: { conversationId: string, conversationType: "dm"|"channel", messages: unknown[], sourceCursor?: object }) => Promise<{ inserted: number, updated: number, ignored: number }>} applyServerMessages
 * @property {(contacts: unknown[]) => Promise<{ upserted: number, ignored: number }>} [applyContacts]
 * @property {(channels: unknown[]) => Promise<{ upserted: number, ignored: number }>} [applyChannels]
 * @property {() => unknown} [getDriver]
 *   Used to persist `meta.bootstrap_completed_at` after a successful
 *   pass. Optional so test fakes that only stub `applyServerMessages`
 *   keep working.
 */

/**
 * @typedef {Object} BootstrapApiClient
 * @property {(url: string, opts?: { withCredentials?: boolean, params?: Record<string, unknown> }) => Promise<{ data?: unknown }>} get
 */

/**
 * @typedef {Object} BootstrapDiagnostics
 * @property {(e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void} log
 */

/**
 * @typedef {Object} RunBootstrapOptions
 * @property {BootstrapRepository} repository
 * @property {BootstrapApiClient} apiClient
 * @property {BootstrapDiagnostics} diagnostics
 * @property {(pathOrUrl: string) => string} buildUrl
 *   Prepend the configured `host` to relative paths. Pulled from the
 *   engine so the host override stays in one place.
 * @property {string|null} [userId]
 *   Bound to the engine's authenticated user; only used in diagnostic
 *   metadata.
 * @property {number} [pageLimit]
 *   Defaults to {@link DEFAULT_PAGE_LIMIT}.
 * @property {number[]} [bootstrapBackoffMs]
 *   Override the bootstrap backoff schedule. Defaults to
 *   {@link BOOTSTRAP_BACKOFF_MS}. The length defines the retry budget
 *   (Req 4.5).
 * @property {() => number} [now]
 * @property {() => number} [random]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(status: "none"|"partial"|"ok") => void} [onBootstrapStatusChange]
 *   Optional sink the engine uses to mirror `bootstrap_status` into its
 *   own state (and ultimately into `useAppStore` via
 *   `OfflineProvider` — Req 4.2).
 * @property {(phase: "bootstrap"|"ready"|"degraded") => void} [onPhaseChange]
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {BootstrapApiClient} apiClient
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

/**
 * Compute the jittered delay for `attempt` (1-indexed: the first retry
 * is `attempt = 1`). Returns `0` when the schedule is exhausted.
 *
 * @param {number} attempt
 * @param {number[]} schedule
 * @param {() => number} random
 * @returns {number}
 */
function bootstrapBackoff(attempt, schedule, random) {
  if (attempt < 1 || attempt > schedule.length) return 0;
  const base = schedule[attempt - 1];
  const jitter = base * BOOTSTRAP_JITTER_FRACTION * (random() * 2 - 1);
  return Math.max(0, Math.floor(base + jitter));
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

/**
 * Fetch the current user's DM contact list and channel list, then return
 * the unified set of conversations to bootstrap. Failures here propagate
 * as a global bootstrap failure (Req 4.3 — without contacts/channels
 * there is nothing to fetch).
 *
 * Exported so {@link runIncremental} can reuse the same list-fetch
 * shape — incremental sync also needs the union of conversations to
 * scan (catching up conversations that appeared while offline).
 *
 * @param {{ apiClient: BootstrapApiClient, buildUrl: (p: string) => string, diagnostics: BootstrapDiagnostics }} ctx
 * @returns {Promise<{ conversations: ConversationRef[], contactsRaw: unknown[], channelsRaw: unknown[] }>}
 */
export async function fetchConversationList(ctx) {
  const httpGet = makeHttpGet(ctx.apiClient, ctx.buildUrl);
  /** @type {unknown[]} */
  let contactsRaw = [];
  /** @type {unknown[]} */
  let channelsRaw = [];
  try {
    const data = await httpGet(DM_CONTACTS_ROUTE);
    if (Array.isArray(data)) contactsRaw = data;
  } catch (err) {
    ctx.diagnostics.log({
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
    ctx.diagnostics.log({
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
    if (id != null) conversations.push({ id, type: "dm" });
  }
  for (const ch of channelsRaw) {
    const id = asId(ch);
    if (id != null) conversations.push({ id, type: "channel" });
  }
  return { conversations, contactsRaw, channelsRaw };
}

// ---------------------------------------------------------------------------
// Per-conversation runner
// ---------------------------------------------------------------------------

/**
 * Drive a single conversation's bootstrap with retry + backoff (Req 4.5).
 *
 * Bootstrap omits `since` so the backend serves the most-recent page in
 * legacy descending order; the response is fed straight into
 * `applyServerMessages` (the conflict resolver does not care about
 * order, but the helper preserves the original engine behavior of
 * passing the array through verbatim).
 *
 * @param {ConversationRef} conv
 * @param {{
 *   apiClient: BootstrapApiClient,
 *   buildUrl: (p: string) => string,
 *   repository: BootstrapRepository,
 *   diagnostics: BootstrapDiagnostics,
 *   pageLimit: number,
 *   schedule: number[],
 *   sleep: (ms: number) => Promise<void>,
 *   random: () => number,
 *   now: () => number,
 * }} ctx
 * @returns {Promise<{ ok: boolean, partial: boolean, attempts: number }>}
 */
export async function runBootstrapConversation(conv, ctx) {
  const httpGet = makeHttpGet(ctx.apiClient, ctx.buildUrl);
  const route =
    conv.type === "dm" ? PRIVATE_CONTACT_MESSAGES_ROUTE : CHANNEL_MESSAGES_ROUTE;

  /** @type {Error | null} */
  let lastErr = null;
  const totalAttempts = ctx.schedule.length + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const phaseStart = ctx.now();
    try {
      /** @type {unknown[]} */
      let messages = [];
      const data = await httpGet(`${route}/${conv.id}`, { limit: ctx.pageLimit });
      if (Array.isArray(data)) messages = data;
      await ctx.repository.applyServerMessages({
        conversationId: conv.id,
        conversationType: conv.type,
        messages,
      });
      ctx.diagnostics.log({
        category: "bootstrap",
        code: "BOOTSTRAP_CONVERSATION_OK",
        outcome: "ok",
        durationMs: ctx.now() - phaseStart,
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
      ctx.diagnostics.log({
        category: "bootstrap",
        code: "BOOTSTRAP_CONVERSATION_RETRY",
        outcome: "warn",
        durationMs: ctx.now() - phaseStart,
        meta: {
          conversationId: conv.id,
          conversationType: conv.type,
          attempt: attempt + 1,
          reason: describeError(err),
        },
      });
      if (attempt < ctx.schedule.length) {
        await ctx.sleep(bootstrapBackoff(attempt + 1, ctx.schedule, ctx.random));
      }
    }
  }
  ctx.diagnostics.log({
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

// ---------------------------------------------------------------------------
// Full bootstrap pass
// ---------------------------------------------------------------------------

/**
 * Run a single Bootstrap_Sync pass: fetch the contact + channel lists,
 * then page each conversation once with retry + backoff. The helper
 * always returns a {@link BootstrapResult} (it never throws past the
 * boundary the engine sees).
 *
 * @param {RunBootstrapOptions} options
 * @returns {Promise<BootstrapResult>}
 */
export async function runBootstrap(options) {
  if (options == null || options.repository == null) {
    throw new Error("runBootstrap: repository is required");
  }
  if (options.apiClient == null || typeof options.apiClient.get !== "function") {
    throw new Error("runBootstrap: apiClient.get is required");
  }
  if (options.diagnostics == null || typeof options.diagnostics.log !== "function") {
    throw new Error("runBootstrap: diagnostics is required");
  }
  if (typeof options.buildUrl !== "function") {
    throw new Error("runBootstrap: buildUrl is required");
  }

  const repository = options.repository;
  const apiClient = options.apiClient;
  const diagnostics = options.diagnostics;
  const buildUrl = options.buildUrl;
  const pageLimit =
    typeof options.pageLimit === "number" && options.pageLimit > 0
      ? Math.floor(options.pageLimit)
      : DEFAULT_PAGE_LIMIT;
  const schedule =
    Array.isArray(options.bootstrapBackoffMs) && options.bootstrapBackoffMs.length > 0
      ? options.bootstrapBackoffMs.slice()
      : BOOTSTRAP_BACKOFF_MS.slice();
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random = typeof options.random === "function" ? options.random : () => Math.random();
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const onBootstrapStatusChange =
    typeof options.onBootstrapStatusChange === "function"
      ? options.onBootstrapStatusChange
      : null;
  const onPhaseChange =
    typeof options.onPhaseChange === "function" ? options.onPhaseChange : null;

  const startedAt = now();
  if (onPhaseChange) onPhaseChange("bootstrap");
  diagnostics.log({
    category: "bootstrap",
    code: "BOOTSTRAP_STARTED",
    outcome: "ok",
    meta: { userId: options.userId != null ? options.userId : null },
  });

  /** @type {ConversationRef[]} */
  let conversations = [];
  /** @type {unknown[]} */
  let contactsRaw = [];
  /** @type {unknown[]} */
  let channelsRaw = [];
  try {
    const lists = await fetchConversationList({ apiClient, buildUrl, diagnostics });
    conversations = lists.conversations;
    contactsRaw = lists.contactsRaw;
    channelsRaw = lists.channelsRaw;
  } catch (err) {
    if (onPhaseChange) onPhaseChange("degraded");
    if (onBootstrapStatusChange) onBootstrapStatusChange("partial");
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

  // Persist the contact + channel lists into the repository before
  // fanning out per-conversation message fetches. The list payload
  // already carries the user display fields and last-message preview
  // so the UI can render the sidebar from the local DB on next launch
  // (Req 1.1, Req 4.3). Failures here are non-fatal: the per-conversation
  // pass below still runs and the next incremental pass will retry the
  // upsert.
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
  const ctx = {
    apiClient,
    buildUrl,
    repository,
    diagnostics,
    pageLimit,
    schedule,
    sleep,
    random,
    now,
  };
  for (const conv of conversations) {
    const result = await runBootstrapConversation(conv, ctx);
    if (result.ok) {
      okCount += 1;
    } else {
      partialCount += 1;
      partialIds.push(conv.id);
    }
  }

  // Req 4.6: set global status to `ready` after all conversations
  // finish, even when some are partial — partial conversations do not
  // block the rest of the app from coming online.
  if (onPhaseChange) onPhaseChange("ready");
  if (onBootstrapStatusChange) {
    onBootstrapStatusChange(partialCount === 0 ? "ok" : "partial");
  }
  const durationMs = now() - startedAt;

  // Persist `meta.bootstrap_completed_at` so subsequent boots can tell
  // the difference between "never bootstrapped" and "already bootstrapped
  // at least once" without relying on `sync_cursors` row count as a
  // proxy. The latter is unreliable: a partial pass can seed cursors
  // for some conversations while leaving the contacts / channels tables
  // empty (the bug this fix is targeting). We only write the meta key
  // when at least one conversation succeeded — a wholly-failed pass is
  // not "completed".
  if (
    okCount > 0 &&
    typeof repository.getDriver === "function"
  ) {
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
}
