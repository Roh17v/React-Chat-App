// @ts-check
/**
 * Unit tests for the Media_Cache (task 13.1 / 13.2).
 *
 * Drives the cache against an in-memory SQLite test driver so the SQL is
 * exercised end-to-end. The Capacitor Filesystem and axios calls are
 * stubbed by `makeFilesystem()` / `makeHttp()`.
 *
 * Properties 13 / 14 / 15 are covered by the dedicated property test
 * files (`MediaCache.property.test.js` etc., separate optional tasks).
 * This suite covers the example-based behaviours: auto-download
 * decision, retry/backoff, getCachedMediaPath readability check, LRU
 * eviction shape, profile image swap, and the downloadOnTap force path.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createTestSqliteDriver } from "../db/drivers/sqlite.testDriver.js";
import { createMigrator } from "../db/Migrator.js";
import { createDiagnostics } from "../utils/Diagnostics.js";
import { createPerConversationMutex } from "../utils/PerConversationMutex.js";
import { createRepository } from "../repositories/index.js";

import {
  createMediaCache,
  MEDIA_CACHE_PATH,
  MEDIA_PROFILE_PATH,
} from "./MediaCache.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/**
 * Build a repository wired to an in-memory SQLite test driver. Mirrors the
 * pattern used by `OutboundQueue.test.js` so the two suites stay in sync.
 */
async function makeRepository() {
  const driver = createTestSqliteDriver();
  await driver.open();
  const diagnostics = createDiagnostics();
  const migrator = createMigrator({ diagnostics });
  const mutex = createPerConversationMutex();

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
    mutex,
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
 * In-memory Filesystem stub. Records every write, reports `stat` based on
 * what's been written, and (optionally) lets the caller force `writeFile`
 * to fail.
 */
function makeFilesystem(opts = {}) {
  /** @type {Map<string, { data: string, byteSize: number }>} */
  const files = new Map();
  const writeFile = vi.fn(async ({ path, data }) => {
    if (opts.failWriteUntil != null && writeFile.mock.calls.length <= opts.failWriteUntil) {
      throw new Error("DISK_FULL");
    }
    const byteSize = computeBase64ByteSize(data);
    files.set(path, { data, byteSize });
    return undefined;
  });
  const readFile = vi.fn(async ({ path }) => {
    const f = files.get(path);
    if (f == null) throw new Error("ENOENT");
    return { data: f.data };
  });
  const deleteFile = vi.fn(async ({ path }) => {
    files.delete(path);
    return undefined;
  });
  const stat = vi.fn(async ({ path }) => {
    const f = files.get(path);
    if (f == null) throw new Error("ENOENT");
    return { size: f.byteSize, type: "file" };
  });
  const mkdir = vi.fn(async () => undefined);
  return {
    writeFile,
    readFile,
    deleteFile,
    stat,
    mkdir,
    files,
  };
}

/**
 * Approximate byte size of a base64 payload. Sufficient for tests.
 */
function computeBase64ByteSize(data) {
  if (typeof data !== "string" || data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Build an axios-shaped HTTP client that returns a fixed payload for any
 * URL (or a per-URL map). Tracks the call sequence so backoff tests can
 * assert how many times the request was retried.
 */
function makeHttp({ payload, perUrl, failures } = {}) {
  /** @type {Array<string>} */
  const calls = [];
  let remainingFailures = typeof failures === "number" ? failures : 0;
  return {
    calls,
    /**
     * @param {string} url
     */
    async get(url) {
      calls.push(url);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error(`SIMULATED_FAILURE_${remainingFailures}`);
      }
      const body =
        perUrl != null && Object.prototype.hasOwnProperty.call(perUrl, url)
          ? perUrl[url]
          : payload != null
            ? payload
            : new Uint8Array([1, 2, 3, 4, 5]);
      return {
        data: body,
        headers: { "content-type": "application/octet-stream" },
      };
    },
  };
}

/**
 * Deterministic hasher that returns the URL itself (after hex-escaping the
 * non-alphanumeric characters). Keeps on-disk paths predictable in tests.
 */
async function fakeHasher(url) {
  return Buffer.from(String(url)).toString("hex").slice(0, 32);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto-download decision", () => {
  it("downloads small files and writes the row in 'downloaded' status", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([1, 2, 3, 4]) });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
      budgetBytes: 1_073_741_824,
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/a/small.png",
      fileMetadata: { byteSize: 256, mimeType: "image/png" },
    });

    // onLiveMessage is fire-and-forget; flush microtasks via the
    // in-flight map.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(http.calls).toEqual(["https://example.com/a/small.png"]);
    expect(filesystem.writeFile).toHaveBeenCalledTimes(1);
    const writeArg = filesystem.writeFile.mock.calls[0][0];
    expect(writeArg.path).toMatch(new RegExp(`^${MEDIA_CACHE_PATH}/`));
    expect(writeArg.path.endsWith(".png")).toBe(true);

    const rows = await driver.query(
      "SELECT server_file_url, status, byte_size, mime_type, " +
        "downloaded_at, last_accessed_at FROM media_cache",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].server_file_url).toBe("https://example.com/a/small.png");
    expect(rows[0].status).toBe("downloaded");
    expect(rows[0].byte_size).toBe(4);
    expect(rows[0].downloaded_at).toBeTypeOf("string");
    expect(rows[0].last_accessed_at).toBeTypeOf("string");
  });

  it("skips download when byteSize > autoDownloadMaxBytes (Req 8.7)", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp();
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/big.zip",
      fileMetadata: { byteSize: 5_000 },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(http.calls).toEqual([]);
    expect(filesystem.writeFile).not.toHaveBeenCalled();

    const rows = await driver.query(
      "SELECT status, byte_size FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/big.zip"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("not_downloaded");
    expect(rows[0].byte_size).toBe(5_000);
  });

  it("ignores non-file messages and messages without fileUrl", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp();
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
    });

    await cache.onLiveMessage({ messageType: "text", content: "hi" });
    await cache.onLiveMessage({ messageType: "file", fileUrl: "" });
    await cache.onLiveMessage({ messageType: "file" });
    await Promise.resolve();

    expect(http.calls).toEqual([]);
    const rows = await driver.query("SELECT COUNT(*) AS n FROM media_cache");
    expect(rows[0].n).toBe(0);
  });

  it("processes batches via onServerMessages without short-circuiting on a bad item", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([9]) });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
    });

    await cache.onServerMessages([
      { messageType: "text", content: "ignored" },
      { messageType: "file", fileUrl: "https://example.com/a", fileMetadata: { byteSize: 10 } },
      { messageType: "file" }, // missing url
      { messageType: "file", fileUrl: "https://example.com/b", fileMetadata: { byteSize: 10 } },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(http.calls.sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    const rows = await driver.query(
      "SELECT server_file_url, status FROM media_cache ORDER BY server_file_url ASC",
    );
    expect(rows).toEqual([
      { server_file_url: "https://example.com/a", status: "downloaded" },
      { server_file_url: "https://example.com/b", status: "downloaded" },
    ]);
  });
});

describe("retry / backoff (Req 8.9)", () => {
  it("retries up to maxAttempts then marks the row download_failed", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ failures: 99 }); // always fail
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
      maxAttempts: 3,
      // Skip the actual sleep — we don't care about real timing here.
      setTimeoutFn: (fn) => {
        fn();
        return 0;
      },
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/a/fail.bin",
      fileMetadata: { byteSize: 100 },
    });
    // Wait for the in-flight promise to settle.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(http.calls).toHaveLength(3);
    expect(filesystem.writeFile).not.toHaveBeenCalled();
    const rows = await driver.query(
      "SELECT status, attempts FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/a/fail.bin"],
    );
    expect(rows[0].status).toBe("download_failed");
    expect(rows[0].attempts).toBe(3);
  });

  it("succeeds on a later attempt without requeuing", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([1]), failures: 2 });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
      maxAttempts: 3,
      setTimeoutFn: (fn) => {
        fn();
        return 0;
      },
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/a/recover.bin",
      fileMetadata: { byteSize: 1 },
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(http.calls).toHaveLength(3);
    expect(filesystem.writeFile).toHaveBeenCalledTimes(1);
    const rows = await driver.query(
      "SELECT status FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/a/recover.bin"],
    );
    expect(rows[0].status).toBe("downloaded");
  });

  it("dedupes concurrent requests for the same URL", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([1]) });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
    });

    const url = "https://example.com/dedupe.png";
    await Promise.all([
      cache.onLiveMessage({ messageType: "file", fileUrl: url, fileMetadata: { byteSize: 1 } }),
      cache.onLiveMessage({ messageType: "file", fileUrl: url, fileMetadata: { byteSize: 1 } }),
      cache.onLiveMessage({ messageType: "file", fileUrl: url, fileMetadata: { byteSize: 1 } }),
    ]);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(http.calls.filter((c) => c === url)).toHaveLength(1);
    const rows = await driver.query(
      "SELECT COUNT(*) AS n FROM media_cache WHERE server_file_url = ?",
      [url],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("getCachedMediaPath (Req 8.3 / 8.4)", () => {
  it("returns the local path for a downloaded row and bumps last_accessed_at", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([1, 2, 3]) });
    let nowMs = 1_000_000;
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
      now: () => nowMs,
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/get.bin",
      fileMetadata: { byteSize: 3 },
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const before = await driver.query(
      "SELECT last_accessed_at FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/get.bin"],
    );
    const beforeTs = before[0].last_accessed_at;

    nowMs += 60_000;
    const path = await cache.getCachedMediaPath("https://example.com/get.bin");
    expect(path).toBeTypeOf("string");
    expect(path?.startsWith(MEDIA_CACHE_PATH)).toBe(true);

    const after = await driver.query(
      "SELECT last_accessed_at FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/get.bin"],
    );
    expect(after[0].last_accessed_at).not.toBe(beforeTs);
  });

  it("returns null when the row is in non-downloaded statuses", async () => {
    const { repository } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp();
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/big",
      fileMetadata: { byteSize: 1_000_000 },
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const path = await cache.getCachedMediaPath("https://example.com/big");
    expect(path).toBeNull();
  });

  it("returns null and flips the row to download_failed when the file is missing", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([7]) });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
    });

    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/gone",
      fileMetadata: { byteSize: 1 },
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // Simulate the OS evicting the underlying file out from under us.
    filesystem.files.clear();

    const path = await cache.getCachedMediaPath("https://example.com/gone");
    expect(path).toBeNull();

    const rows = await driver.query(
      "SELECT status FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/gone"],
    );
    expect(rows[0].status).toBe("download_failed");
  });

  it("returns null for an unknown URL", async () => {
    const { repository } = await makeRepository();
    const cache = createMediaCache({
      repository,
      filesystem: makeFilesystem(),
      http: makeHttp(),
      hash: fakeHasher,
      isNativePlatform: () => true,
    });

    expect(await cache.getCachedMediaPath("https://nope")).toBeNull();
    expect(await cache.getCachedMediaPath("")).toBeNull();
  });
});

describe("evictIfOverBudget (Req 8.6)", () => {
  it("evicts the oldest rows until total ≤ budget and respects the cooldown window", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp();
    let nowMs = 10_000_000;
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      now: () => nowMs,
      cooldownMs: 5_000,
      budgetBytes: 100,
    });

    // Seed three rows directly: two old, one recent.
    const seed = async (url, size, accessedAtMs) => {
      const path = `${MEDIA_CACHE_PATH}/${url.replace(/\W/g, "_")}.bin`;
      filesystem.files.set(path, { data: "x", byteSize: size });
      await driver.run(
        `INSERT INTO media_cache (server_file_url, local_file_path, mime_type,
           byte_size, status, attempts, downloaded_at, last_accessed_at)
         VALUES (?, ?, NULL, ?, 'downloaded', 0, ?, ?)`,
        [
          url,
          path,
          size,
          new Date(accessedAtMs - 1000).toISOString(),
          new Date(accessedAtMs).toISOString(),
        ],
      );
    };
    await seed("u1", 60, nowMs - 30_000); // oldest, evictable
    await seed("u2", 60, nowMs - 20_000); // older, evictable
    await seed("u3", 60, nowMs - 1_000); // accessed within cooldown, KEEP

    const result = await cache.evictIfOverBudget();
    // u1 freed 60 bytes -> 120 total, still > 100, so u2 also goes.
    // After u2 we are at 60 bytes, ≤ 100 budget, stop.
    // u3 stays because it was accessed within the cooldown window.
    expect(result.evicted).toBe(2);
    expect(result.bytesFreed).toBe(120);

    const remaining = await driver.query(
      "SELECT server_file_url FROM media_cache ORDER BY server_file_url ASC",
    );
    expect(remaining.map((r) => r.server_file_url)).toEqual(["u3"]);
  });

  it("is a no-op when total ≤ budget", async () => {
    const { repository, driver } = await makeRepository();
    const cache = createMediaCache({
      repository,
      filesystem: makeFilesystem(),
      http: makeHttp(),
      hash: fakeHasher,
      isNativePlatform: () => true,
      budgetBytes: 1_000_000,
    });

    await driver.run(
      `INSERT INTO media_cache (server_file_url, local_file_path, byte_size,
         status, downloaded_at, last_accessed_at)
       VALUES ('u', '/p', 100, 'downloaded', ?, ?)`,
      [new Date(0).toISOString(), new Date(0).toISOString()],
    );

    const result = await cache.evictIfOverBudget();
    expect(result).toEqual({ evicted: 0, bytesFreed: 0 });
  });
});

describe("onUserImageChanged (Req 8.8)", () => {
  it("evicts the old profile image and queues a fresh download for the new one", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([1]) });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1024,
    });

    // Seed an existing profile image.
    const oldUrl = "https://example.com/old.jpg";
    const oldPath = `${MEDIA_PROFILE_PATH}/old.jpg`;
    filesystem.files.set(oldPath, { data: "x", byteSize: 1 });
    await driver.run(
      `INSERT INTO media_cache (server_file_url, local_file_path, byte_size,
         status, downloaded_at, last_accessed_at)
       VALUES (?, ?, 1, 'downloaded', ?, ?)`,
      [oldUrl, oldPath, new Date(0).toISOString(), new Date(0).toISOString()],
    );

    await cache.onUserImageChanged({
      userId: "user-1",
      oldImage: oldUrl,
      newImage: "https://example.com/new.jpg",
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const rows = await driver.query(
      "SELECT server_file_url, status FROM media_cache ORDER BY server_file_url ASC",
    );
    // Old row removed; new row inserted in 'downloaded' state.
    expect(rows.find((r) => r.server_file_url === oldUrl)).toBeUndefined();
    const newRow = rows.find((r) => r.server_file_url === "https://example.com/new.jpg");
    expect(newRow).toBeDefined();
    expect(newRow.status).toBe("downloaded");
    expect(filesystem.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: oldPath }),
    );
    // New file was written under MEDIA_PROFILE_PATH (Req 8.8).
    const newWrite = filesystem.writeFile.mock.calls.find(
      ([arg]) => arg.path.startsWith(`${MEDIA_PROFILE_PATH}/`),
    );
    expect(newWrite).toBeDefined();
  });

  it("no-ops when the URL is unchanged", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp();
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
    });

    await cache.onUserImageChanged({
      userId: "x",
      oldImage: "https://example.com/same.jpg",
      newImage: "https://example.com/same.jpg",
    });
    await Promise.resolve();
    expect(http.calls).toEqual([]);
    const rows = await driver.query("SELECT COUNT(*) AS n FROM media_cache");
    expect(rows[0].n).toBe(0);
  });
});

describe("downloadOnTap (task 13.2 / Req 8.7)", () => {
  it("force-downloads even when byteSize > autoDownloadMaxBytes", async () => {
    const { repository, driver } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ payload: new Uint8Array([1, 2, 3, 4]) });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      autoDownloadMaxBytes: 1, // tiny so the auto path would skip.
    });

    // Pre-seed a "not_downloaded" row as if onLiveMessage had recorded it.
    await cache.onLiveMessage({
      messageType: "file",
      fileUrl: "https://example.com/big",
      fileMetadata: { byteSize: 1024 },
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(http.calls).toEqual([]); // auto path skipped

    const result = await cache.downloadOnTap("https://example.com/big", {
      byteSize: 1024,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.localFilePath.startsWith(MEDIA_CACHE_PATH)).toBe(true);
    }
    expect(http.calls).toEqual(["https://example.com/big"]);

    const row = await driver.query(
      "SELECT status FROM media_cache WHERE server_file_url = ?",
      ["https://example.com/big"],
    );
    expect(row[0].status).toBe("downloaded");
  });

  it("returns an error result when the URL is empty or missing", async () => {
    const { repository } = await makeRepository();
    const cache = createMediaCache({
      repository,
      filesystem: makeFilesystem(),
      http: makeHttp(),
      hash: fakeHasher,
      isNativePlatform: () => true,
    });
    expect(await cache.downloadOnTap("")).toEqual({
      ok: false,
      reason: "INVALID_URL",
    });
  });

  it("propagates download failures as a typed error", async () => {
    const { repository } = await makeRepository();
    const filesystem = makeFilesystem();
    const http = makeHttp({ failures: 99 });
    const cache = createMediaCache({
      repository,
      filesystem,
      http,
      hash: fakeHasher,
      isNativePlatform: () => true,
      maxAttempts: 1,
      setTimeoutFn: (fn) => {
        fn();
        return 0;
      },
    });

    const result = await cache.downloadOnTap("https://example.com/fail");
    expect(result).toEqual({ ok: false, reason: "DOWNLOAD_FAILED" });
  });
});

describe("getTotalCachedBytes", () => {
  it("sums byte_size across only 'downloaded' rows", async () => {
    const { repository, driver } = await makeRepository();
    const cache = createMediaCache({
      repository,
      filesystem: makeFilesystem(),
      http: makeHttp(),
      hash: fakeHasher,
      isNativePlatform: () => true,
    });
    await driver.run(
      `INSERT INTO media_cache (server_file_url, local_file_path, byte_size, status)
       VALUES ('a', '/a', 100, 'downloaded'),
              ('b', '/b', 200, 'downloaded'),
              ('c', '/c', 999, 'not_downloaded'),
              ('d', '/d', 50, 'download_failed')`,
    );
    expect(await cache.getTotalCachedBytes()).toBe(300);
  });
});
