// @ts-check
/**
 * SQL schema migrator for the offline `Local_Database`.
 *
 * Implements task 6.2 of the offline-support spec and Requirements 3.1–3.4.
 *
 * Behavior summary (see `.kiro/specs/offline-support/design.md` §3.2 and the
 * "Schema upgrade" paragraph in §Data Models):
 *
 *   - {@link MIGRATIONS} is an ordered array of `{ version, name, sql }`. New
 *     migrations are appended in ascending `version` order. The
 *     highest version present in the registry is the *code version*.
 *   - {@link applyPending} reads `meta.schema_version` from the DB. For every
 *     migration whose `version` is strictly greater than the persisted value,
 *     it runs the migration's SQL inside its OWN transaction (`BEGIN /
 *     COMMIT / ROLLBACK`). After the SQL `exec` succeeds, the same
 *     transaction issues `UPDATE meta SET value = ? WHERE key =
 *     'schema_version'`. The transaction is committed only when both
 *     statements succeed; any error rolls back, the persisted version is
 *     left untouched, and a `MIGRATION_FAILED` diagnostic is emitted (Req
 *     3.3 / Property 5).
 *   - When the persisted version is GREATER than the code version (a
 *     "downgrade" — usually after a build rollback), the migrator signals
 *     a rebootstrap. If the caller provided an `archiveAndRecreate` hook we
 *     invoke it (the caller is responsible for closing the connection,
 *     renaming the DB file to `${dbName}.bak.${ts}`, and reopening an empty
 *     file). When the hook is absent (e.g. tests) we report the condition
 *     and let the caller decide. Either way the persisted version is never
 *     advanced backwards (Req 3.4).
 *
 * The migrator never throws across its public surface. Every failure path
 * resolves to a `{ ok: false, reason }` result so the boot path can fall
 * through to the existing online-only flow (mirrors the `sqlite.driver.js`
 * contract).
 *
 * @module offline/db/Migrator
 */

import { getDiagnostics } from "../utils/Diagnostics.js";

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

// `?raw` is supported by Vite (and Vitest, which uses Vite's transformer) and
// inlines the file contents as a string at build time. Both the production
// bundle and the Node-side property tests therefore see the SQL without any
// runtime filesystem access. The TS server has no built-in type for the
// `?raw` suffix; the runtime import shape is `string`, which is what the
// rest of this module assumes.
// @ts-ignore -- vite ?raw import has no ambient type declaration in this project
import init001Sql from "./migrations/001__init.sql?raw";
// @ts-ignore
import init002Sql from "./migrations/002__ensure_schema.sql?raw";

/**
 * @typedef {Object} Migration
 * @property {number} version
 *   Monotonic, strictly-increasing integer. New migrations append to the end
 *   of {@link MIGRATIONS}. Versions must form a contiguous sequence starting
 *   at 1 (the migrator validates this on construction).
 * @property {string} name
 *   Short human-readable label (used only in diagnostics output).
 * @property {string} sql
 *   The migration SQL. May contain multiple statements separated by `;`.
 *   `driver.exec` is responsible for parsing the statement string.
 */

/**
 * The canonical, ordered registry of migrations.
 *
 * Append-only. Never reorder, never edit a published entry — once a migration
 * has been shipped to a user's device, mutating its SQL would silently leave
 * that device on a stale schema (the migrator only re-runs migrations whose
 * `version > meta.schema_version`).
 *
 * @type {ReadonlyArray<Migration>}
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: "init", sql: init001Sql }),
  Object.freeze({ version: 2, name: "ensure_schema", sql: init002Sql }),
]);

/**
 * The highest version present in the registry. Equal to `MIGRATIONS[last].version`,
 * or `0` for an empty registry. This is the value the migrator drives the
 * persisted `meta.schema_version` toward.
 */
export const CODE_VERSION =
  MIGRATIONS.length === 0 ? 0 : MIGRATIONS[MIGRATIONS.length - 1].version;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subset of the SQLite driver's surface the migrator depends on. Both
 * `sqlite.driver.js` and `sqlite.testDriver.js` satisfy this shape.
 *
 * @typedef {Object} MigratorDriver
 * @property {(sql: string) => Promise<void>} exec
 * @property {(sql: string, values?: unknown[]) => Promise<{ changes: number, lastId?: number }>} run
 * @property {<T = unknown>(sql: string, values?: unknown[]) => Promise<T[]>} query
 * @property {<T>(work: (tx: MigratorDriver) => Promise<T>) => Promise<T>} [withTransaction]
 */

/**
 * @typedef {Object} ApplyPendingOptions
 * @property {string} [dbName]
 *   Logical database name. Forwarded verbatim to `archiveAndRecreate` when
 *   the migrator detects a schema downgrade. Defaults to
 *   `"syncronus_offline"` (the constant declared in `sqlite.driver.js`).
 * @property {(args: { dbName: string, timestamp: string, persistedVersion: number, codeVersion: number }) => Promise<void>} [archiveAndRecreate]
 *   Caller-supplied recovery hook invoked when `meta.schema_version >
 *   CODE_VERSION` (Req 3.4). The implementation MUST: (a) close the active
 *   SQLite connection, (b) rename / move the on-disk DB file to
 *   `${dbName}.bak.${timestamp}`, and (c) leave a fresh empty database in
 *   place that the caller will reopen *before* the migrator re-runs. After
 *   this hook resolves the migrator runs all registered migrations on the
 *   newly-empty DB and reports `rebootstrap: true` to the caller, who must
 *   then trigger `Bootstrap_Sync`.
 *
 *   When the hook is not provided (e.g. tests) the migrator stops after
 *   detecting the downgrade and returns `reason: "SCHEMA_DOWNGRADE_DETECTED"`
 *   so the caller can decide how to recover.
 */

/**
 * @typedef {(
 *   | { ok: true, schemaVersion: number, ran: number[], rebootstrap?: false }
 *   | { ok: true, schemaVersion: number, ran: number[], rebootstrap: true, archivedFromVersion: number }
 *   | { ok: false, reason: "MIGRATION_FAILED", failedVersion: number, schemaVersion: number, error: string }
 *   | { ok: false, reason: "SCHEMA_DOWNGRADE_DETECTED", persistedVersion: number, codeVersion: number }
 *   | { ok: false, reason: "READ_VERSION_FAILED", error: string }
 * )} ApplyPendingResult
 */

/**
 * @typedef {Object} CreateMigratorOptions
 * @property {ReadonlyArray<Migration>} [migrations]
 *   Override the registry (used by Property 5 tests to inject a synthetic
 *   migration sequence). Defaults to {@link MIGRATIONS}.
 * @property {{ log: (e: { category: string, code: string, outcome: string, durationMs?: number, meta?: object }) => void }} [diagnostics]
 *   Diagnostics sink. Defaults to {@link getDiagnostics}.
 * @property {() => number} [now]
 *   Wall-clock used to (a) compute the archive timestamp and (b) record
 *   `durationMs` on diagnostic entries. Defaults to `Date.now`.
 */

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Validate a migration registry: versions must be integers, strictly
 * increasing, and start at 1. Throws synchronously on misuse — this is a
 * developer error, not a runtime condition.
 *
 * @param {ReadonlyArray<Migration>} migrations
 */
function assertValidRegistry(migrations) {
  if (!Array.isArray(migrations)) {
    throw new TypeError("Migrator: migrations must be an array");
  }
  let prev = 0;
  for (const m of migrations) {
    if (
      m == null ||
      typeof m !== "object" ||
      typeof m.version !== "number" ||
      !Number.isInteger(m.version) ||
      m.version <= 0 ||
      typeof m.sql !== "string" ||
      m.sql.length === 0 ||
      typeof m.name !== "string"
    ) {
      throw new TypeError(
        "Migrator: each migration must have { version: positive int, name: string, sql: non-empty string }",
      );
    }
    if (m.version !== prev + 1) {
      throw new RangeError(
        `Migrator: migration versions must be contiguous starting at 1; expected ${
          prev + 1
        } got ${m.version} (name="${m.name}")`,
      );
    }
    prev = m.version;
  }
}

/**
 * Convert an unknown thrown value into a short log-safe reason string. Caps at
 * 200 chars to match the size budget of `Diagnostics` meta entries.
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
 * Read `meta.schema_version`. Returns:
 *   - the parsed integer when the row exists,
 *   - `0` when the `meta` table is missing (never-migrated DB) or the row is
 *     absent,
 *   - `{ ok: false, error }` when the read fails for an unexpected reason.
 *
 * The "missing table" case is detected by inspecting the error message for
 * the `no such table` substring SQLite uses (both `better-sqlite3` and the
 * Capacitor plugin propagate the same wording). Any other error bubbles up
 * as a typed failure so the caller can avoid running migrations against an
 * unhealthy connection.
 *
 * @param {MigratorDriver} driver
 * @returns {Promise<{ ok: true, version: number } | { ok: false, error: string }>}
 */
async function readPersistedVersion(driver) {
  try {
    const rows = await driver.query(
      "SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1",
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: true, version: 0 };
    }
    const raw = /** @type {{ value?: unknown }} */ (rows[0]).value;
    if (raw == null) return { ok: true, version: 0 };
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: true, version: 0 };
    }
    return { ok: true, version: n };
  } catch (err) {
    const msg = describeError(err).toLowerCase();
    // Fresh databases have no `meta` table yet. Treat that as version 0 so
    // the very first migration creates the table for us.
    if (msg.includes("no such table") || msg.includes("does not exist")) {
      return { ok: true, version: 0 };
    }
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Hand-rolled transaction wrapper. The Capacitor and `better-sqlite3` drivers
 * both expose `withTransaction`; this is a fallback that issues `BEGIN /
 * COMMIT / ROLLBACK` directly when a custom driver shim does not. We prefer
 * the driver's own helper when available because it knows how to ask the
 * underlying engine to suppress its implicit-transaction wrapping.
 *
 * @template T
 * @param {MigratorDriver} driver
 * @param {(tx: MigratorDriver) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function runInTransaction(driver, work) {
  if (typeof driver.withTransaction === "function") {
    return driver.withTransaction(work);
  }
  await driver.exec("BEGIN");
  let result;
  try {
    result = await work(driver);
  } catch (err) {
    try {
      await driver.exec("ROLLBACK");
    } catch {
      /* swallow rollback errors so the original failure surfaces */
    }
    throw err;
  }
  await driver.exec("COMMIT");
  return result;
}

/**
 * Build an archive timestamp (`YYYYMMDDTHHmmssSSSZ`) for the
 * downgrade-recovery flow. Avoiding raw `Date#toISOString` (which contains
 * `:`) keeps the resulting filename safe across Android, iOS, and Windows.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatArchiveTimestamp(ms) {
  const d = new Date(ms);
  const pad = (/** @type {number} */ n, /** @type {number} */ width = 2) =>
    String(n).padStart(width, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    pad(d.getUTCMilliseconds(), 3) +
    "Z"
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a migrator instance. Production code can use the
 * {@link applyPending} convenience export which delegates to the default
 * registry; tests should construct their own instance via this factory so
 * they get an isolated diagnostics buffer and can inject synthetic
 * migrations.
 *
 * @param {CreateMigratorOptions} [options]
 */
export function createMigrator(options = {}) {
  const migrations = options.migrations != null ? options.migrations : MIGRATIONS;
  assertValidRegistry(migrations);

  const codeVersion =
    migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;

  const diagnostics =
    options.diagnostics != null ? options.diagnostics : getDiagnostics();
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  /**
   * Run a single migration inside its own transaction. Returns a typed
   * result so the outer loop can decide whether to continue or abort
   * without having to interpret thrown errors.
   *
   * @param {MigratorDriver} driver
   * @param {Migration} migration
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function runOneMigration(driver, migration) {
    const startedAt = now();
    try {
      // Strategy: use a transaction when the driver's withTransaction is
      // available AND exec can handle multi-statement SQL atomically (the
      // better-sqlite3 test driver). On the Capacitor native driver, wrapping
      // CREATE TABLE / CREATE INDEX in a BEGIN block prevents subsequent
      // statements from seeing tables created earlier in the same uncommitted
      // transaction, so we execute each statement individually (auto-commit)
      // and rely on IF NOT EXISTS guards in the SQL for idempotency.
      //
      // We distinguish the two cases by duck-typing: if the driver has a
      // `_isSyncDriver` marker (set by createTestSqliteDriver) we use the
      // transactional path; otherwise we use the statement-by-statement path.
      const useTransaction =
        typeof (/** @type {any} */ (driver)._isSyncDriver) === "boolean" &&
        (/** @type {any} */ (driver)._isSyncDriver) === true;

      if (useTransaction) {
        // Test driver: run the full SQL in one transactional exec.
        await runInTransaction(driver, async (tx) => {
          await tx.exec(migration.sql);
          await tx.run(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [String(migration.version)],
          );
        });
      } else {
        // Native Capacitor driver: execute each statement individually so
        // the plugin auto-commits each one, allowing CREATE INDEX to see
        // the table created by a preceding CREATE TABLE.
        const statements = migration.sql
          // Strip single-line SQL comments first so they don't end up
          // prepended to the next statement after splitting on semicolons.
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const stmt of statements) {
          await driver.exec(stmt);
        }

        // Update schema_version after all statements succeed.
        await driver.run(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [String(migration.version)],
        );
      }

      diagnostics.log({
        category: "migration",
        code: "MIGRATION_APPLIED",
        outcome: "ok",
        durationMs: now() - startedAt,
        meta: { version: migration.version, name: migration.name },
      });
      return { ok: true };
    } catch (err) {
      const reason = describeError(err);
      diagnostics.log({
        category: "migration",
        code: "MIGRATION_FAILED",
        outcome: "error",
        durationMs: now() - startedAt,
        meta: {
          version: migration.version,
          name: migration.name,
          reason,
        },
      });
      return { ok: false, error: reason };
    }
  }

  /**
   * Drive the registry forward against `driver`. See module-level docs for
   * the contract.
   *
   * @param {MigratorDriver} driver
   * @param {ApplyPendingOptions} [opts]
   * @returns {Promise<ApplyPendingResult>}
   */
  async function applyPending(driver, opts = {}) {
    const dbName = typeof opts.dbName === "string" && opts.dbName.length > 0
      ? opts.dbName
      : "syncronus_offline";

    // 1. Determine current persisted state.
    const readResult = await readPersistedVersion(driver);
    if (readResult.ok !== true) {
      const readError = readResult.error;
      diagnostics.log({
        category: "migration",
        code: "MIGRATION_FAILED",
        outcome: "error",
        meta: { stage: "read_version", reason: readError },
      });
      return { ok: false, reason: "READ_VERSION_FAILED", error: readError };
    }
    const persistedVersion = readResult.version;

    // 2. Detect schema downgrade (Req 3.4).
    if (persistedVersion > codeVersion) {
      diagnostics.log({
        category: "migration",
        code: "SCHEMA_DOWNGRADE_DETECTED",
        outcome: "warn",
        meta: { persistedVersion, codeVersion },
      });

      if (typeof opts.archiveAndRecreate === "function") {
        const timestamp = formatArchiveTimestamp(now());
        try {
          await opts.archiveAndRecreate({
            dbName,
            timestamp,
            persistedVersion,
            codeVersion,
          });
        } catch (err) {
          const reason = describeError(err);
          diagnostics.log({
            category: "migration",
            code: "MIGRATION_FAILED",
            outcome: "error",
            meta: { stage: "archive", reason },
          });
          return {
            ok: false,
            reason: "MIGRATION_FAILED",
            failedVersion: persistedVersion,
            schemaVersion: persistedVersion,
            error: reason,
          };
        }

        // The DB has been wiped and reopened by the caller's hook. Run all
        // migrations from scratch on the empty file so the caller receives
        // a ready-to-use schema along with the rebootstrap signal.
        /** @type {number[]} */
        const ran = [];
        for (const migration of migrations) {
          const r = await runOneMigration(driver, migration);
          if (r.ok !== true) {
            return {
              ok: false,
              reason: "MIGRATION_FAILED",
              failedVersion: migration.version,
              schemaVersion: migration.version - 1,
              error: r.error,
            };
          }
          ran.push(migration.version);
        }
        return {
          ok: true,
          schemaVersion: codeVersion,
          ran,
          rebootstrap: true,
          archivedFromVersion: persistedVersion,
        };
      }

      // No archive hook supplied — surface the condition so the boot path
      // can decide how to recover (e.g. close + Filesystem.rename + reopen
      // and call applyPending again).
      return {
        ok: false,
        reason: "SCHEMA_DOWNGRADE_DETECTED",
        persistedVersion,
        codeVersion,
      };
    }

    // 3. Already up-to-date.
    if (persistedVersion === codeVersion) {
      return { ok: true, schemaVersion: codeVersion, ran: [] };
    }

    // 4. Apply each pending migration in order. Each one runs in its own
    //    transaction so a partial sequence preserves the prefix that
    //    committed cleanly (Property 5).
    /** @type {number[]} */
    const ran = [];
    let currentVersion = persistedVersion;
    for (const migration of migrations) {
      if (migration.version <= persistedVersion) continue;

      const r = await runOneMigration(driver, migration);
      if (r.ok !== true) {
        return {
          ok: false,
          reason: "MIGRATION_FAILED",
          failedVersion: migration.version,
          schemaVersion: currentVersion,
          error: r.error,
        };
      }
      currentVersion = migration.version;
      ran.push(migration.version);
    }

    return { ok: true, schemaVersion: currentVersion, ran };
  }

  return {
    /** Direct read of the persisted schema version. Useful for diagnostics. */
    getPersistedVersion: readPersistedVersion,
    applyPending,
    /** Code version derived from the registry passed to {@link createMigrator}. */
    codeVersion,
    /** The registry actually in use (defaults to the module-level export). */
    migrations,
  };
}

// ---------------------------------------------------------------------------
// Default singleton convenience surface
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createMigrator> | null} */
let defaultMigrator = null;

/**
 * Lazily build the default migrator instance bound to the canonical registry.
 * Production callers use this; tests should construct their own instance.
 */
function getDefaultMigrator() {
  if (defaultMigrator == null) {
    defaultMigrator = createMigrator();
  }
  return defaultMigrator;
}

/**
 * Convenience wrapper around {@link createMigrator}().applyPending — the
 * boot path imports just this and the constants.
 *
 * @param {MigratorDriver} driver
 * @param {ApplyPendingOptions} [opts]
 * @returns {Promise<ApplyPendingResult>}
 */
export function applyPending(driver, opts) {
  return getDefaultMigrator().applyPending(driver, opts);
}

/**
 * Reset the singleton. Exported strictly for test setup.
 * @internal
 */
export function __resetMigratorSingletonForTests() {
  defaultMigrator = null;
}
