// @ts-check
/**
 * Unit tests for the schema migrator.
 *
 * Validates the behaviour required by task 6.2 / Requirements 3.1–3.4:
 *
 *   - Fresh DB (no `meta` table) runs every migration in order, lands at
 *     `meta.schema_version === codeVersion` (Req 3.1, 3.2).
 *   - Already-up-to-date DB is a no-op (Req 3.2).
 *   - Mid-sequence failure rolls back the failing migration's transaction;
 *     `meta.schema_version` stays at `failedVersion - 1`; the schema state
 *     matches the post-state of the previous successful migration; a
 *     `MIGRATION_FAILED` diagnostic is emitted (Req 3.3).
 *   - `meta.schema_version > codeVersion` triggers the archive-and-recreate
 *     hook with `dbName` and a timestamp; on success the migrator re-runs
 *     all migrations and returns `rebootstrap: true` (Req 3.4).
 *   - When no archive hook is supplied, the downgrade is reported via the
 *     typed result so the caller can drive the recovery itself.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createTestSqliteDriver } from "./drivers/sqlite.testDriver.js";
import {
  createMigrator,
  MIGRATIONS,
  CODE_VERSION,
} from "./Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";

/**
 * Synthetic migration set used to exercise the multi-step paths cheaply
 * without depending on the real `001__init.sql` schema.
 */
const SYNTHETIC_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "create_meta_and_t1",
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE t1 (id INTEGER PRIMARY KEY, payload TEXT);
    `,
  }),
  Object.freeze({
    version: 2,
    name: "create_t2",
    sql: `CREATE TABLE t2 (id INTEGER PRIMARY KEY);`,
  }),
  Object.freeze({
    version: 3,
    name: "create_t3",
    sql: `CREATE TABLE t3 (id INTEGER PRIMARY KEY);`,
  }),
]);

describe("Migrator: registry exports", () => {
  it("exposes a non-empty MIGRATIONS array starting at version 1", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0].version).toBe(1);
    expect(MIGRATIONS[0].name).toBe("init");
    // Versions are contiguous.
    for (let i = 1; i < MIGRATIONS.length; i += 1) {
      expect(MIGRATIONS[i].version).toBe(MIGRATIONS[i - 1].version + 1);
    }
    expect(CODE_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it("rejects non-contiguous registries at construction time", () => {
    expect(() =>
      createMigrator({
        migrations: [
          { version: 1, name: "a", sql: "SELECT 1;" },
          { version: 3, name: "c", sql: "SELECT 1;" },
        ],
      }),
    ).toThrow(/contiguous/);
  });
});

describe("Migrator.applyPending — fresh database", () => {
  /** @type {ReturnType<typeof createTestSqliteDriver>} */
  let driver;
  /** @type {ReturnType<typeof createDiagnostics>} */
  let diag;

  beforeEach(async () => {
    driver = createTestSqliteDriver();
    await driver.open();
    diag = createDiagnostics();
  });

  it("runs every synthetic migration in order and lands at codeVersion", async () => {
    const migrator = createMigrator({
      migrations: SYNTHETIC_MIGRATIONS,
      diagnostics: diag,
    });

    const result = await migrator.applyPending(driver);

    expect(result).toEqual({ ok: true, schemaVersion: 3, ran: [1, 2, 3] });

    const rows = await driver.query(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect(rows).toEqual([{ value: "3" }]);

    // Every synthetic table exists.
    for (const t of ["t1", "t2", "t3"]) {
      const r = await driver.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t],
      );
      expect(r.length).toBe(1);
    }

    const codes = diag.snapshot().events.map((e) => e.code);
    expect(codes).toEqual([
      "MIGRATION_APPLIED",
      "MIGRATION_APPLIED",
      "MIGRATION_APPLIED",
    ]);
  });

  it("applies the canonical 001__init.sql migration", async () => {
    const migrator = createMigrator({ diagnostics: diag });
    const result = await migrator.applyPending(driver);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrowing for the type checker
    expect(result.schemaVersion).toBe(CODE_VERSION);

    // Check a couple of seeded meta rows.
    const meta = await driver.query("SELECT key, value FROM meta ORDER BY key");
    const map = Object.fromEntries(
      /** @type {Array<{ key: string, value: string }>} */ (meta).map((r) => [
        r.key,
        r.value,
      ]),
    );
    expect(map.schema_version).toBe(String(CODE_VERSION));
    expect(map.local_encryption).toBe("none");
    expect(map.next_queue_seq).toBe("0");
    expect(map.media_budget_bytes).toBe("1073741824");
    expect(map.media_auto_download_max_bytes).toBe("26214400");
  });
});

describe("Migrator.applyPending — already up-to-date", () => {
  it("is a no-op when meta.schema_version == codeVersion", async () => {
    const driver = createTestSqliteDriver();
    await driver.open();
    const diag = createDiagnostics();
    const migrator = createMigrator({
      migrations: SYNTHETIC_MIGRATIONS,
      diagnostics: diag,
    });

    // First pass: bring the DB up to v3.
    const first = await migrator.applyPending(driver);
    expect(first).toEqual({ ok: true, schemaVersion: 3, ran: [1, 2, 3] });

    diag.clear();
    // Second pass: nothing to do.
    const second = await migrator.applyPending(driver);
    expect(second).toEqual({ ok: true, schemaVersion: 3, ran: [] });
    expect(diag.snapshot().events.length).toBe(0);
  });
});

describe("Migrator.applyPending — failure mid-sequence", () => {
  it("rolls back the failing migration and stays at the prior version", async () => {
    const driver = createTestSqliteDriver();
    await driver.open();
    const diag = createDiagnostics();

    // Migration 2 includes invalid SQL after a CREATE TABLE so we can verify
    // the entire migration's effects (including the partial CREATE TABLE)
    // are rolled back atomically.
    const migrations = [
      SYNTHETIC_MIGRATIONS[0],
      Object.freeze({
        version: 2,
        name: "broken_t2",
        sql: `
          CREATE TABLE t2 (id INTEGER PRIMARY KEY);
          THIS IS NOT VALID SQL;
        `,
      }),
      SYNTHETIC_MIGRATIONS[2],
    ];

    const migrator = createMigrator({ migrations, diagnostics: diag });
    const result = await migrator.applyPending(driver);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("MIGRATION_FAILED");
    expect(result.failedVersion).toBe(2);
    expect(result.schemaVersion).toBe(1);

    // Persisted version reflects only the migrations that committed.
    const rows = await driver.query(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect(rows).toEqual([{ value: "1" }]);

    // Migration 1's effect is present, migration 2's effect is rolled back.
    const t1 = await driver.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='t1'",
    );
    expect(t1.length).toBe(1);
    const t2 = await driver.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='t2'",
    );
    expect(t2.length).toBe(0);
    // And migration 3 was never attempted.
    const t3 = await driver.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='t3'",
    );
    expect(t3.length).toBe(0);

    const events = diag.snapshot().events;
    const failed = events.find((e) => e.code === "MIGRATION_FAILED");
    expect(failed).toBeDefined();
    expect(failed?.outcome).toBe("error");
    expect(failed?.meta?.version).toBe(2);
  });
});

describe("Migrator.applyPending — schema downgrade (Req 3.4)", () => {
  it("invokes archiveAndRecreate and re-runs all migrations on the empty DB", async () => {
    // Stage 1: bring the DB to v3 and then *another* connection is opened on
    // an empty file by the archive hook to simulate the recreate step.
    const v3Driver = createTestSqliteDriver();
    await v3Driver.open();
    {
      const m = createMigrator({ migrations: SYNTHETIC_MIGRATIONS });
      const r = await m.applyPending(v3Driver);
      expect(r.ok).toBe(true);
    }

    // Stage 2: simulate a code rollback — the running app's registry only
    // knows about migrations 1 and 2, but the persisted DB is at v3.
    const downgradedMigrations = [
      SYNTHETIC_MIGRATIONS[0],
      SYNTHETIC_MIGRATIONS[1],
    ];

    // The archive hook closes the old driver and points the migrator at a
    // fresh in-memory DB. This mirrors what `OfflineProvider` does on real
    // devices: closeConnection → rename file → createConnection.
    let archiveCalledWith = null;
    const freshDriver = createTestSqliteDriver();
    await freshDriver.open();

    const migrator = createMigrator({
      migrations: downgradedMigrations,
    });
    const result = await migrator.applyPending(v3Driver, {
      dbName: "test_offline",
      archiveAndRecreate: async (args) => {
        archiveCalledWith = args;
        await v3Driver.close();
        // After the hook returns the migrator continues running statements
        // on `v3Driver` though — so we have to swap the connection inside
        // the same driver object. The simplest way is to leave `v3Driver`
        // closed and route subsequent calls through `freshDriver` by
        // monkey-patching the methods. We do that here so the migrator's
        // post-archive `runOneMigration` lands on the empty DB.
        v3Driver.exec = freshDriver.exec;
        v3Driver.run = freshDriver.run;
        v3Driver.query = freshDriver.query;
        v3Driver.withTransaction = freshDriver.withTransaction;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schemaVersion).toBe(2);
    expect(result.ran).toEqual([1, 2]);
    expect(/** @type {{ rebootstrap?: boolean }} */ (result).rebootstrap).toBe(true);
    expect(/** @type {{ archivedFromVersion?: number }} */ (result).archivedFromVersion).toBe(3);

    expect(archiveCalledWith).toMatchObject({
      dbName: "test_offline",
      persistedVersion: 3,
      codeVersion: 2,
    });
    expect(typeof /** @type {any} */ (archiveCalledWith).timestamp).toBe("string");

    // The fresh DB is now at v2 with t1 and t2, and `meta.schema_version`
    // reflects the post-recreate version.
    const rows = await freshDriver.query(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect(rows).toEqual([{ value: "2" }]);
    const t3 = await freshDriver.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='t3'",
    );
    expect(t3.length).toBe(0);

    await freshDriver.close();
  });

  it("returns SCHEMA_DOWNGRADE_DETECTED when no archive hook is supplied", async () => {
    const driver = createTestSqliteDriver();
    await driver.open();

    // Bring DB to v3 via the full registry...
    {
      const m = createMigrator({ migrations: SYNTHETIC_MIGRATIONS });
      const r = await m.applyPending(driver);
      expect(r.ok).toBe(true);
    }

    // ...then run with a registry that only knows about v1 and no hook.
    const migrator = createMigrator({
      migrations: [SYNTHETIC_MIGRATIONS[0]],
    });
    const result = await migrator.applyPending(driver);
    expect(result).toEqual({
      ok: false,
      reason: "SCHEMA_DOWNGRADE_DETECTED",
      persistedVersion: 3,
      codeVersion: 1,
    });

    // Persisted version is unchanged.
    const rows = await driver.query(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect(rows).toEqual([{ value: "3" }]);
  });
});
