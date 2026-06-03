// @ts-check
/**
 * Server message → Local row conflict resolver.
 *
 * Implements the §3.6 conflict-resolution path of the offline-support design.
 * Owned by task 8.1 (the spec calls out a refinement pass there); this minimal
 * implementation lands here as part of task 7.2 because the repository write
 * methods need it. Task 8.1 will likely add: streaming of the optimistic-merge
 * outcome up to the UI, finer-grained ignore reasons, and any additional
 * subscription notifications.
 *
 * Behavior summary (Req 5.5, 9.1, 9.2, 9.3, 9.7):
 *
 *   1. Look up an existing local row by `server_id` first; if absent and the
 *      server payload carries a `clientTempId`, look up by
 *      `client_temp_id WHERE server_id IS NULL` to merge an optimistic local
 *      row with its server confirmation.
 *   2. No local row → INSERT with `sync_state = "confirmed"`. We generate a
 *      fresh local UUID for `id`. `client_temp_id`, `queue_seq`, and
 *      `local_file_path` are left null (server-originated rows never enter
 *      the outbound queue).
 *   3. Local row exists → pick a winner using the design's rules:
 *        - If the local row was deleted-for-everyone but the server payload
 *          claims it is not, the server only wins when `server.updatedAt`
 *          is STRICTLY greater than the local row (we never silently
 *          resurrect a deleted message because of a stale incoming payload).
 *        - Otherwise, the server payload wins unless its `updatedAt` is
 *          strictly older than the local row AND the local row is already
 *          confirmed (i.e. not `local_only`). Ties on `updatedAt` go to the
 *          server (Property 16). Local pending/`local_only` rows always
 *          accept the server payload, which implements Req 9.3.
 *   4. On a server-wins update, preserve the local-only fields exactly:
 *      `client_temp_id`, `queue_seq`, `local_file_path`, `deleted_for_me`.
 *      Use {@link monotonicMaxStatus} to reconcile the status field so that
 *      Req 7.5 / 7.6 are respected even when the server payload would move
 *      the row backwards.
 *
 * The function is pure with respect to its driver argument: every read and
 * write goes through the supplied `tx`. Callers are expected to wrap this in
 * a single `driver.withTransaction(async (tx) => …)` so that any failure
 * mid-batch rolls the whole batch back (Req 5.4 atomicity).
 *
 * @module offline/sync/conflictResolver
 */

import { v4 as uuidv4 } from "uuid";

import { toLocalRow } from "../utils/wireFormat.js";
import { monotonicMaxStatus } from "./statusLifecycle.js";

/**
 * Subset of the SqliteDriver / TestSqliteDriver surface this module depends
 * on. The repository passes the `tx` parameter from `driver.withTransaction`
 * here, which already conforms to this shape.
 *
 * @typedef {Object} ResolverTx
 * @property {<T = unknown>(sql: string, values?: unknown[]) => Promise<T[]>} query
 * @property {(sql: string, values?: unknown[]) => Promise<{ changes: number, lastId?: number }>} run
 */

/**
 * @typedef {Object} ResolveContext
 * @property {string} conversationId
 *   The local DB's `conversation_id` scope for the row. The SyncEngine
 *   determines this from the perspective of the local user (the "other party"
 *   for DMs, the channel id for channel messages). The resolver does not
 *   second-guess this — if the caller supplies a different `conversationId`
 *   for the same `server_id`, the existing row is updated in place but its
 *   `conversation_id` column is NOT changed (we never reassign messages
 *   across conversations in v1).
 * @property {"dm"|"channel"} conversationType
 * @property {() => string} [uuid]
 *   Override the UUID generator. Defaults to `uuid.v4`. Useful for tests
 *   that assert deterministic ids.
 */

/**
 * @typedef {(
 *   | { outcome: "inserted", id: string }
 *   | { outcome: "updated", id: string }
 *   | { outcome: "merged", id: string }
 *   | { outcome: "ignored", id?: string, reason: string }
 *   | { outcome: "rejected", error: { kind: string, field?: string } }
 * )} ResolveOutcome
 */

/**
 * Convert a SQLite integer value (which may come back as 0/1, "0"/"1", or
 * BigInt) into a JS boolean. Defensive: any non-truthy non-numeric input
 * collapses to `false`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function toBool(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (typeof value === "bigint") return value !== BigInt(0);
  return false;
}

/**
 * Apply a single server message to the local DB through the provided tx.
 *
 * @param {ResolverTx} tx
 * @param {unknown} serverMessage
 * @param {ResolveContext} ctx
 * @returns {Promise<ResolveOutcome>}
 */
export async function resolveAndApply(tx, serverMessage, ctx) {
  // 0. Validate context.
  if (
    ctx == null ||
    typeof ctx.conversationId !== "string" ||
    ctx.conversationId.length === 0 ||
    (ctx.conversationType !== "dm" && ctx.conversationType !== "channel")
  ) {
    return {
      outcome: "rejected",
      error: { kind: "INVALID_CONTEXT", field: "conversationId" },
    };
  }

  // 1. Parse the server payload through the wire-format serializer. Missing
  //    required fields surface as a typed error (Req 12.5) — we propagate
  //    that as a rejection rather than letting it crash the batch.
  const wireResult = toLocalRow(serverMessage);
  if (wireResult.ok !== true) {
    return { outcome: "rejected", error: wireResult.error };
  }
  const incoming = wireResult.value;

  // 2. Lookup existing local row. server_id first, then client_temp_id.
  /** @type {Record<string, unknown> | null} */
  let local = null;

  const byServer = /** @type {Record<string, unknown>[]} */ (
    await tx.query("SELECT * FROM messages WHERE server_id = ? LIMIT 1", [
      incoming.serverId,
    ])
  );
  if (Array.isArray(byServer) && byServer.length > 0) {
    local = byServer[0];
  }

  if (local == null && typeof incoming.clientTempId === "string" && incoming.clientTempId.length > 0) {
    const byTemp = /** @type {Record<string, unknown>[]} */ (
      await tx.query(
        "SELECT * FROM messages WHERE client_temp_id = ? AND server_id IS NULL LIMIT 1",
        [incoming.clientTempId],
      )
    );
    if (Array.isArray(byTemp) && byTemp.length > 0) {
      local = byTemp[0];
    }
  }

  // 3. No local row → pure insert.
  if (local == null) {
    const generateUuid = typeof ctx.uuid === "function" ? ctx.uuid : uuidv4;
    const id = generateUuid();
    await tx.run(
      `INSERT INTO messages (
         id, server_id, client_temp_id, conversation_id, conversation_type,
         sender_id, receiver_id, channel_id, message_type,
         content, file_url, file_name, file_metadata_json, reply_to_json,
         status, deleted_for_everyone, deleted_for_me, deleted_at,
         created_at, updated_at, sync_state, queue_seq, local_file_path
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        incoming.serverId,
        incoming.clientTempId,
        ctx.conversationId,
        ctx.conversationType,
        incoming.senderId,
        incoming.receiverId,
        incoming.channelId,
        incoming.messageType,
        incoming.content,
        incoming.fileUrl,
        incoming.fileName,
        incoming.fileMetadataJson,
        incoming.replyToJson,
        incoming.status,
        incoming.deletedForEveryone ? 1 : 0,
        0,
        incoming.deletedAt,
        incoming.createdAt,
        incoming.updatedAt,
        "confirmed",
        null,
        null,
      ],
    );
    return { outcome: "inserted", id };
  }

  // 4. Local row exists — decide winner.
  const localId = String(local.id);
  const localServerId =
    typeof local.server_id === "string" && local.server_id.length > 0
      ? local.server_id
      : null;
  const localUpdatedAt =
    typeof local.updated_at === "string" ? local.updated_at : "";
  const localStatus = typeof local.status === "string" ? local.status : "sent";
  const localSyncState =
    typeof local.sync_state === "string" ? local.sync_state : "confirmed";
  const localDeletedForEveryone = toBool(local.deleted_for_everyone);

  // 4a. Resurrection guard. If the local row is already deleted-for-everyone
  //     and the server payload says otherwise, only accept it if the server's
  //     updatedAt is STRICTLY greater. A tied or older payload is treated as
  //     stale and ignored — this prevents a re-sync from undoing a deletion
  //     the user already saw.
  if (localDeletedForEveryone && incoming.deletedForEveryone === false) {
    if (incoming.updatedAt <= localUpdatedAt) {
      return { outcome: "ignored", id: localId, reason: "STALE_RESURRECTION" };
    }
  }

  // 4b. Stale-server guard. A server payload older than a confirmed local row
  //     is ignored. Pending (`local_only`) rows always accept the server
  //     payload so optimistic-send confirmations land regardless of clock
  //     skew (Req 9.3).
  if (incoming.updatedAt < localUpdatedAt && localSyncState !== "local_only") {
    return { outcome: "ignored", id: localId, reason: "STALE_PAYLOAD" };
  }

  // 5. Server wins. Reconcile status with the lifecycle helper so we never
  //    move a confirmed row backwards (Req 7.5 / 7.6 / Property 12).
  const nextStatus = monotonicMaxStatus(localStatus, incoming.status);

  await tx.run(
    `UPDATE messages SET
       server_id = ?,
       sender_id = ?,
       receiver_id = ?,
       channel_id = ?,
       message_type = ?,
       content = ?,
       file_url = ?,
       file_name = ?,
       file_metadata_json = ?,
       reply_to_json = ?,
       status = ?,
       deleted_for_everyone = ?,
       deleted_at = ?,
       created_at = ?,
       updated_at = ?,
       sync_state = 'confirmed'
     WHERE id = ?`,
    [
      incoming.serverId,
      incoming.senderId,
      incoming.receiverId,
      incoming.channelId,
      incoming.messageType,
      incoming.content,
      incoming.fileUrl,
      incoming.fileName,
      incoming.fileMetadataJson,
      incoming.replyToJson,
      nextStatus,
      incoming.deletedForEveryone ? 1 : 0,
      incoming.deletedAt,
      incoming.createdAt,
      incoming.updatedAt,
      localId,
    ],
  );

  // 6. Outcome label. "merged" means an optimistic local row got its
  //    server_id assigned for the first time; "updated" means an already
  //    server-confirmed row received a fresh payload (e.g. a status bump
  //    or a deletion). The repository forwards the count to the SyncEngine
  //    for telemetry.
  return {
    outcome: localServerId == null ? "merged" : "updated",
    id: localId,
  };
}
