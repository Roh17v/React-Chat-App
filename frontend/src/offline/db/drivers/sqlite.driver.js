// @ts-check
/**
 * Capacitor SQLite driver — the native counterpart of `sqlite.testDriver.js`.
 *
 * Implements §3.2 of the offline-support design and Requirements 2.1, 2.4,
 * 2.5. Owns the single `SQLiteDBConnection` for the user; all repository,
 * migrator, and outbound-queue work funnels through this surface.
 *
 * Public surface:
 *
 *   interface SqliteDriver {
 *     open(opts: { dbName: string; passphrase: string; readOnly?: boolean })
 *       : Promise<{ ok: true } | { ok: false; reason: string }>;
 *     close(): Promise<void>;
 *     exec(sql: string): Promise<void>;
 *     run(sql: string, values?: unknown[])
 *       : Promise<{ changes: number; lastId?: number }>;
 *     query<T>(sql: string, values?: unknown[]): Promise<T[]>;
 *     withTransaction<T>(work: (tx: SqliteDriver) => Promise<T>): Promise<T>;
 *   }
 *
 * The shape mirrors `sqlite.testDriver.js` exactly so the repository layer can
 * be exercised against `better-sqlite3` in CI and against this native driver
 * in the Capacitor build with no call-site changes.
 *
 * Open sequence (taken straight from §3.2):
 *
 *   1.  `Capacitor.isNativePlatform()` gate. Off-native runtimes (web build /
 *       Node tests / SSR) short-circuit to `{ ok: false, reason:
 *       "PLATFORM_UNSUPPORTED" }` and never touch the plugin (Req 2.5).
 *   2.  `new SQLiteConnection(CapacitorSQLite)` — the JS-side bookkeeping
 *       wrapper. Owns the `_connectionDict`, so we must use the same instance
 *       for the lifetime of the driver.
 *   3.  `checkConnectionsConsistency()` — clears any stale JS-vs-native
 *       mismatch. If this throws we cannot proceed; bubble up
 *       `SQLITE_CONSISTENCY_FAILED` and let the boot path take the
 *       online-only fallback.
 *   4.  `isConnection(dbName, readOnly)` — reuse a live connection if the
 *       plugin already owns one (e.g. across a hot-reload). Otherwise call
 *       `createConnection(dbName, encrypted=true, "secret", version,
 *       readOnly)`. The encryption secret MUST already be in the plugin's
 *       secret store at this point — see §3.8 / `EncryptionLayer.js`.
 *   5.  `conn.open()` — actually opens the SQLCipher database file.
 *
 * Every error path funnels through Diagnostics with a stable code (see the
 * `## Error Handling → Initialization failures` table in design.md):
 *
 *   - `PLATFORM_UNSUPPORTED`        — non-native runtime.
 *   - `SQLITE_CONSISTENCY_FAILED`   — `checkConnectionsConsistency` rejected.
 *   - `SQLITE_OPEN_FAILED`          — `isConnection`, `createConnection`,
 *                                     `retrieveConnection`, or `conn.open()`
 *                                     rejected.
 *
 * Errors are *also* surfaced to the caller via the return value (`{ ok:
 * false, reason }`). The driver never throws from `open()`; that lets the
 * boot path cleanly fall through to the existing online-only flow without a
 * try/catch around init (Req 2.5).
 *
 * Transaction semantics:
 *
 *   The plugin's `execute`/`run` methods accept a `transaction` flag that,
 *   when true (default), wraps the statement in an implicit BEGIN/COMMIT.
 *   We always pass `transaction=false` so callers can compose statements
 *   inside an explicit `withTransaction(work)` block. `withTransaction`
 *   issues `BEGIN`/`COMMIT`/`ROLLBACK` itself via `conn.execute` with
 *   `transaction=false`, so they are not double-wrapped.
 *
 * Concurrency:
 *
 *   The driver does not serialize concurrent calls. The repository layer is
 *   responsible for serializing writes through `PerConversationMutex` (§3.5).
 *   `withTransaction` MUST therefore be called from within that mutex; the
 *   driver does not detect or guard against nested transactions because the
 *   plugin would surface a clear SQLite error if that ever happened.
 *
 * @module offline/db/drivers/sqlite.driver
 */

import { SQLiteConnection, CapacitorSQLite } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";

import { getDiagnostics } from "../../utils/Diagnostics.js";

/**
 * Schema-upgrade slot version forwarded to `createConnection`. The plugin uses
 * this only for its built-in `addUpgradeStatement` migration mechanism, which
 * we deliberately do NOT use — our own `Migrator` (task 6.2) drives schema
 * evolution. We pin it at `1` and never advance it; advancing it would
 * confuse the plugin's internal state without changing our behavior.
 */
const PLUGIN_CONNECTION_VERSION = 1;

/**
 * @typedef {Object} SqliteOpenOptions
 * @property {string} dbName
 *   Logical database name. The plugin strips a trailing `.db` and stores the
 *   file under the app-private sandbox.
 * @property {string} passphrase
 *   Hex-encoded SQLCipher passphrase, present only on first run when the
 *   `EncryptionLayer` just generated the key. On subsequent runs callers
 *   pass an empty string and the plugin reads the key from its secret store
 *   via `mode="secret"`. The driver does not call `setEncryptionSecret`
 *   itself; that is the `EncryptionLayer`'s responsibility (§3.8).
 * @property {boolean} [readOnly=false]
 *   Open the connection read-only. The plugin maintains separate
 *   `RO_<db>`/`RW_<db>` connection slots, so a read-only and a read-write
 *   handle on the same file can coexist if needed.
 */

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} SqliteOpenResult
 */

/**
 * @typedef {Object} SqliteRunResult
 * @property {number} changes
 * @property {number} [lastId]
 */

/**
 * @typedef {Object} SqliteDriver
 * @property {(opts: SqliteOpenOptions) => Promise<SqliteOpenResult>} open
 * @property {() => Promise<void>} close
 * @property {(sql: string) => Promise<void>} exec
 * @property {(sql: string, values?: unknown[]) => Promise<SqliteRunResult>} run
 * @property {<T = unknown>(sql: string, values?: unknown[]) => Promise<T[]>} query
 * @property {<T>(work: (tx: SqliteDriver) => Promise<T>) => Promise<T>} withTransaction
 * @property {() => boolean} isOpen
 * @property {(dbName: string) => Promise<void>} deleteDatabase
 */

/**
 * Subset of the `SQLiteConnection` API the driver actually uses. Tests can
 * inject a stub that satisfies this shape without pulling in the real plugin
 * (which has no Node implementation).
 *
 * @typedef {Object} SqliteConnectionLike
 * @property {() => Promise<unknown>} checkConnectionsConsistency
 * @property {(database: string, readonly: boolean) => Promise<{ result?: boolean } | boolean>} isConnection
 * @property {(database: string, readonly: boolean) => Promise<SqliteDbConnectionLike>} retrieveConnection
 * @property {(database: string, encrypted: boolean, mode: string, version: number, readonly: boolean) => Promise<SqliteDbConnectionLike>} createConnection
 * @property {(database: string, readonly: boolean) => Promise<unknown>} closeConnection
 * @property {(database: string, readonly: boolean) => Promise<unknown>} deleteDatabase
 */

/**
 * Subset of the `SQLiteDBConnection` API the driver actually uses.
 *
 * @typedef {Object} SqliteDbConnectionLike
 * @property {() => Promise<unknown>} open
 * @property {() => Promise<unknown>} close
 * @property {(statements: string, transaction?: boolean, isSQL92?: boolean) => Promise<unknown>} execute
 * @property {(statement: string, values?: unknown[], transaction?: boolean, returnMode?: string, isSQL92?: boolean) => Promise<{ changes?: { changes?: number, lastId?: number } }>} run
 * @property {(statement: string, values?: unknown[], isSQL92?: boolean) => Promise<{ values?: unknown[] }>} query
 */

/**
 * @typedef {Object} CreateSqliteDriverOptions
 * @property {SqliteConnectionLike} [sqlite]
 *   Connection wrapper to use. Defaults to `new SQLiteConnection(CapacitorSQLite)`.
 *   Tests inject a stub here.
 * @property {{ log: (e: { category: string, code: string, outcome: string, meta?: object }) => void }} [diagnostics]
 *   Diagnostics sink. Defaults to {@link getDiagnostics}.
 * @property {() => boolean} [isNativePlatform]
 *   Returns whether the runtime can host the SQLite plugin. Defaults to
 *   `Capacitor.isNativePlatform()`.
 */

/**
 * Normalize the SQLite plugin's "boolean-ish" return shape. `isConnection`
 * resolves to `{ result: boolean }`; some forks return a bare boolean. Treat
 * both as equivalent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function unwrapBool(value) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "result" in value) {
    const r = /** @type {{ result?: unknown }} */ (value).result;
    return Boolean(r);
  }
  return false;
}

/**
 * Convert an unknown thrown value into a short, log-safe reason string.
 * Caps at 200 chars to keep diagnostics buffer entries small.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err.slice(0, 200);
  if (err instanceof Error) return (err.message || err.name || "error").slice(0, 200);
  try {
    return String(err).slice(0, 200);
  } catch {
    return "unprintable";
  }
}

/**
 * Build a fresh SQLite driver. Tests should construct their own instance via
 * this factory; production code should prefer {@link getSqliteDriver}.
 *
 * @param {CreateSqliteDriverOptions} [options]
 * @returns {SqliteDriver}
 */
export function createSqliteDriver(options = {}) {
  const sqlite =
    options.sqlite != null
      ? options.sqlite
      : /** @type {SqliteConnectionLike} */ (
          /** @type {unknown} */ (new SQLiteConnection(CapacitorSQLite))
        );
  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const isNativePlatform =
    typeof options.isNativePlatform === "function"
      ? options.isNativePlatform
      : () => Capacitor.isNativePlatform();

  /** @type {SqliteDbConnectionLike | null} */
  let conn = null;
  /** @type {string | null} */
  let openDbName = null;
  let openReadOnly = false;

  /**
   * @returns {SqliteDbConnectionLike}
   */
  function ensureOpen() {
    if (conn == null) {
      throw new Error("sqlite.driver: connection is not open");
    }
    return conn;
  }

  /** @type {SqliteDriver["open"]} */
  async function open({ dbName, passphrase: _passphrase, readOnly = false }) {
    // Step 1: platform gate. Off-native runtimes never touch the plugin so
    // `vite dev`, jsdom tests, and SSR cannot blow up on the missing native
    // bindings (Req 2.5, §3.10 cause #3).
    if (!isNativePlatform()) {
      diagnostics.log({
        category: "boot",
        code: "PLATFORM_UNSUPPORTED",
        outcome: "warn",
        meta: { component: "sqlite.driver" },
      });
      return { ok: false, reason: "PLATFORM_UNSUPPORTED" };
    }

    if (typeof dbName !== "string" || dbName.length === 0) {
      diagnostics.log({
        category: "boot",
        code: "SQLITE_OPEN_FAILED",
        outcome: "error",
        meta: { stage: "validate", reason: "invalid dbName" },
      });
      return { ok: false, reason: "OPEN_FAILED" };
    }

    // Step 2 (already done at construction time): SQLiteConnection bookkeeping
    // wrapper. Reusing the same instance for the lifetime of the driver keeps
    // the plugin's _connectionDict in sync with our own state.

    // Step 3: checkConnectionsConsistency. Critical — see §3.10 cause #4:
    // skipping this lets `Connection ... already exists` errors leak out of
    // `createConnection` after a hot reload or process restart on dev.
    try {
      await sqlite.checkConnectionsConsistency();
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "SQLITE_CONSISTENCY_FAILED",
        outcome: "error",
        meta: { reason: describeError(err) },
      });
      return { ok: false, reason: "CONSISTENCY_FAILED" };
    }

    // Step 4: isConnection → retrieveConnection or createConnection. We treat
    // any failure of the probe itself as an open-failure since we cannot
    // safely fall back to createConnection without knowing the plugin's view.
    let alreadyExists = false;
    try {
      const probe = await sqlite.isConnection(dbName, readOnly);
      alreadyExists = unwrapBool(probe);
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "SQLITE_OPEN_FAILED",
        outcome: "error",
        meta: { stage: "isConnection", reason: describeError(err) },
      });
      return { ok: false, reason: "OPEN_FAILED" };
    }

    /** @type {SqliteDbConnectionLike} */
    let nextConn;
    try {
      if (alreadyExists) {
        nextConn = await sqlite.retrieveConnection(dbName, readOnly);
      } else {
        // The encrypted=true / mode="secret" combination tells the plugin to
        // open SQLCipher and read the passphrase from its secret store. The
        // EncryptionLayer is responsible for having seeded that store before
        // we got here (§3.8). The `passphrase` arg on this method is
        // informational; we do NOT call setEncryptionSecret from the driver.
        nextConn = await sqlite.createConnection(
          dbName,
          /* encrypted */ true,
          /* mode */ "secret",
          PLUGIN_CONNECTION_VERSION,
          readOnly,
        );
      }
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "SQLITE_OPEN_FAILED",
        outcome: "error",
        meta: {
          stage: alreadyExists ? "retrieveConnection" : "createConnection",
          reason: describeError(err),
        },
      });
      return { ok: false, reason: "OPEN_FAILED" };
    }

    // Step 5: actually open the underlying SQLite file. Until this resolves
    // the connection handle is unusable; if it rejects we drop our reference
    // so a subsequent `open()` retry starts cleanly.
    try {
      await nextConn.open();
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "SQLITE_OPEN_FAILED",
        outcome: "error",
        meta: { stage: "open", reason: describeError(err) },
      });
      // Best-effort cleanup so we do not leak a half-opened connection slot
      // into the plugin's _connectionDict for the next attempt.
      if (!alreadyExists) {
        try {
          await sqlite.closeConnection(dbName, readOnly);
        } catch {
          /* swallow — primary failure is already logged */
        }
      }
      return { ok: false, reason: "OPEN_FAILED" };
    }

    conn = nextConn;
    openDbName = dbName;
    openReadOnly = readOnly;
    return { ok: true };
  }

  /** @type {SqliteDriver["close"]} */
  async function close() {
    if (conn == null) return;
    const dbName = openDbName;
    const readOnly = openReadOnly;
    // Drop our reference first so a re-entrant call (e.g. from a finally
    // block) is a no-op and we never operate on a half-closed handle.
    const handle = conn;
    conn = null;
    openDbName = null;
    openReadOnly = false;
    try {
      await handle.close();
    } catch {
      /* swallow — close is best-effort and the slot still gets removed below */
    }
    if (typeof dbName === "string") {
      try {
        await sqlite.closeConnection(dbName, readOnly);
      } catch {
        /* swallow */
      }
    }
  }

  /** @type {SqliteDriver["exec"]} */
  async function exec(sql) {
    const handle = ensureOpen();
    // `transaction=false` so the plugin does not auto-wrap in BEGIN/COMMIT.
    // The Migrator splits multi-statement SQL itself and calls exec() once
    // per statement, so this path always receives a single statement.
    await handle.execute(sql, /* transaction */ false);
  }

  /** @type {SqliteDriver["run"]} */
  async function run(sql, values) {
    const handle = ensureOpen();
    const args = Array.isArray(values) && values.length > 0 ? values : undefined;
    const res = await handle.run(sql, args, /* transaction */ false);
    const changes = (res && res.changes) || {};
    /** @type {SqliteRunResult} */
    const out = {
      changes: typeof changes.changes === "number" ? changes.changes : 0,
    };
    if (typeof changes.lastId === "number") {
      out.lastId = changes.lastId;
    }
    return out;
  }

  /** @type {SqliteDriver["query"]} */
  async function query(sql, values) {
    const handle = ensureOpen();
    const args = Array.isArray(values) && values.length > 0 ? values : undefined;
    const res = await handle.query(sql, args);
    const rows = res && Array.isArray(res.values) ? res.values : [];
    return /** @type {any} */ (rows);
  }

  /** @type {SqliteDriver["withTransaction"]} */
  async function withTransaction(work) {
    const handle = ensureOpen();
    // `transaction=false` is essential here: if we let the plugin wrap our
    // BEGIN in another implicit BEGIN we get `cannot start a transaction
    // within a transaction` from SQLite.
    await handle.execute("BEGIN", /* transaction */ false);
    let result;
    try {
      result = await work(self);
    } catch (err) {
      // SQLite auto-rolls-back on some errors; guard against issuing a
      // ROLLBACK when no transaction is active so the original error
      // surfaces unmodified.
      try {
        await handle.execute("ROLLBACK", /* transaction */ false);
      } catch {
        /* swallow rollback errors */
      }
      throw err;
    }
    await handle.execute("COMMIT", /* transaction */ false);
    return result;
  }

  function isOpen() {
    return conn != null;
  }

  /**
   * Delete the database file from disk. The connection MUST be closed first.
   *
   * @param {string} dbName
   * @returns {Promise<void>}
   */
  async function deleteDatabase(dbName) {
    if (!isNativePlatform()) return;
    try {
      await CapacitorSQLite.deleteDatabase({ database: dbName });
      diagnostics.log({
        category: "boot",
        code: "SQLITE_DELETED",
        outcome: "ok",
        meta: { dbName },
      });
    } catch (err) {
      diagnostics.log({
        category: "boot",
        code: "SQLITE_DELETE_FAILED",
        outcome: "error",
        meta: { dbName, reason: describeError(err) },
      });
    }
  }

  /** @type {SqliteDriver} */
  const self = {
    open,
    close,
    exec,
    run,
    query,
    withTransaction,
    isOpen,
    deleteDatabase,
  };
  return self;
}

/** @type {SqliteDriver | null} */
let singleton = null;

/**
 * Process-wide SQLite driver used by `OfflineProvider` and the boot path.
 * Tests must construct their own instance via {@link createSqliteDriver}.
 *
 * @returns {SqliteDriver}
 */
export function getSqliteDriver() {
  if (singleton == null) {
    singleton = createSqliteDriver();
  }
  return singleton;
}

/**
 * Reset the singleton. Exported strictly for test setup.
 *
 * @internal
 */
export function __resetSqliteDriverSingletonForTests() {
  singleton = null;
}
