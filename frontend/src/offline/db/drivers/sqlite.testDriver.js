/**
 * @file Node-side test driver shim that mirrors the native
 * `sqlite.driver.js` (see design §3.2) using `better-sqlite3`. This is used by
 * repository / migrator / sync-engine property tests so CI does not have to
 * pull in `@capacitor-community/sqlite` (which would require a native runtime).
 *
 * Contract:
 *
 *   interface SqliteDriver {
 *     open(): Promise<{ ok: true } | { ok: false, reason: string }>;
 *     close(): Promise<void>;
 *     exec(sql: string): Promise<void>;
 *     run(sql, values?): Promise<{ changes: number; lastId?: number }>;
 *     query<T>(sql, values?): Promise<T[]>;
 *     withTransaction<T>(work: (tx) => Promise<T>): Promise<T>;
 *   }
 *
 * better-sqlite3 is fully synchronous, but the methods are still
 * Promise-returning to match the native driver. Internally each call resolves
 * immediately (no microtask gap is observable to callers, but the contract is
 * preserved).
 *
 * `withTransaction` does NOT use better-sqlite3's `db.transaction()` wrapper
 * because that wrapper expects a synchronous function. The work callback we
 * accept is async, so we drive `BEGIN` / `COMMIT` / `ROLLBACK` manually via
 * `.exec()`. This is safe in tests because every underlying read/write is
 * synchronous — `await` between them just yields and resumes.
 */

import Database from "better-sqlite3";

/**
 * @typedef {Object} TestDriverOptions
 * @property {string} [filename=":memory:"] Path to the database file. Defaults
 *   to an in-memory database, which is the desired mode for property tests.
 * @property {boolean} [readonly=false] Open the database in read-only mode.
 * @property {boolean} [verbose=false] When true, log every executed SQL
 *   statement to stderr (useful for debugging a flaky test locally).
 */

/**
 * @typedef {Object} TestSqliteDriver
 * @property {() => Promise<{ ok: true } | { ok: false, reason: string }>} open
 * @property {() => Promise<void>} close
 * @property {(sql: string) => Promise<void>} exec
 * @property {(sql: string, values?: unknown[]) => Promise<{ changes: number, lastId?: number }>} run
 * @property {<T = unknown>(sql: string, values?: unknown[]) => Promise<T[]>} query
 * @property {<T>(work: (tx: TestSqliteDriver) => Promise<T>) => Promise<T>} withTransaction
 * @property {() => import("better-sqlite3").Database} raw Returns the underlying
 *   better-sqlite3 instance. Tests can use this for assertions / setup that go
 *   beyond the driver surface.
 */

/**
 * Coerce better-sqlite3's `lastInsertRowid` (which may be a `BigInt`) into a
 * plain number. SQLite rowids fit comfortably in a Number for any realistic
 * test workload, but BigInt → Number truncates silently for huge values, which
 * is what we want here (tests never hit that range).
 *
 * @param {bigint | number} v
 * @returns {number}
 */
function rowIdToNumber(v) {
  return typeof v === "bigint" ? Number(v) : v;
}

/**
 * Normalize positional bind values for better-sqlite3. The driver contract
 * accepts `undefined` (no params), an array, or a plain object (named params).
 * better-sqlite3 expects array params to be spread as varargs, while object
 * params are passed as a single argument.
 *
 * @param {unknown[] | Record<string, unknown> | undefined} values
 * @returns {unknown[]}
 */
function normalizeBindArgs(values) {
  if (values === undefined || values === null) return [];
  if (Array.isArray(values)) return values;
  // Named-parameter object: pass through as a single argument.
  return [values];
}

/**
 * Create a Node-side SQLite driver that conforms to the same shape as the
 * native Capacitor driver. Used by tests; never imported from production code.
 *
 * @param {TestDriverOptions} [options]
 * @returns {TestSqliteDriver}
 */
export function createTestSqliteDriver(options = {}) {
  const {
    filename = ":memory:",
    readonly = false,
    verbose = false,
  } = options;

  /** @type {import("better-sqlite3").Database} */
  const db = new Database(filename, {
    readonly,
    // eslint-disable-next-line no-console
    verbose: verbose ? (msg) => console.error("[sqlite.testDriver]", msg) : undefined,
  });

  // Match the native driver's pragmas as closely as is meaningful for tests.
  // Foreign keys default off in SQLite; the schema in §Data Models declares
  // FK relationships, so we want the test environment to enforce them too.
  db.pragma("foreign_keys = ON");
  // `journal_mode = MEMORY` makes in-memory transactions slightly faster and
  // avoids any disk artifacts when `filename` is a real path.
  if (filename === ":memory:") {
    db.pragma("journal_mode = MEMORY");
  }

  let closed = false;

  /** @returns {void} */
  function ensureOpen() {
    if (closed) {
      throw new Error("sqlite.testDriver: driver is closed");
    }
  }

  /** @type {TestSqliteDriver["open"]} */
  async function open() {
    // The connection is created eagerly in the factory, so `open` is a no-op
    // that simply confirms readiness. Mirrors the `{ ok: true }` shape that
    // the native driver returns on the happy path.
    if (closed) return { ok: false, reason: "DRIVER_CLOSED" };
    return { ok: true };
  }

  /** @type {TestSqliteDriver["close"]} */
  async function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  /** @type {TestSqliteDriver["exec"]} */
  async function exec(sql) {
    ensureOpen();
    db.exec(sql);
  }

  /** @type {TestSqliteDriver["run"]} */
  async function run(sql, values) {
    ensureOpen();
    const stmt = db.prepare(sql);
    const result = stmt.run(...normalizeBindArgs(values));
    return {
      changes: result.changes,
      lastId: rowIdToNumber(result.lastInsertRowid),
    };
  }

  /** @type {TestSqliteDriver["query"]} */
  async function query(sql, values) {
    ensureOpen();
    const stmt = db.prepare(sql);
    return stmt.all(...normalizeBindArgs(values));
  }

  /** @type {TestSqliteDriver["withTransaction"]} */
  async function withTransaction(work) {
    ensureOpen();
    if (db.inTransaction) {
      // Nested transactions are not part of the native driver's contract.
      // Surface the misuse loudly rather than silently downgrading to a
      // savepoint, which would diverge from production behavior.
      throw new Error("sqlite.testDriver: nested withTransaction is not supported");
    }
    db.exec("BEGIN");
    try {
      const result = await work(tx);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      // SQLite auto-rolls-back on some errors. Guard against issuing a
      // ROLLBACK when no transaction is active to keep the error chain clean.
      if (db.inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Swallow rollback errors so the original failure surfaces below.
        }
      }
      throw err;
    }
  }

  /** @type {TestSqliteDriver} */
  const tx = {
    open,
    close,
    exec,
    run,
    query,
    withTransaction,
    raw: () => db,
    // Marker used by the Migrator to detect the synchronous better-sqlite3
    // driver and use the transactional migration path (vs. the statement-by-
    // statement auto-commit path needed for the Capacitor native driver).
    _isSyncDriver: true,
  };

  return tx;
}

export default createTestSqliteDriver;
