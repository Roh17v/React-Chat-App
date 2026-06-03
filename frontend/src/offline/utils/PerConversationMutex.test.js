// @ts-check
/**
 * Unit tests for the PerConversationMutex (task 7.3).
 *
 * The mutex is the single point of serialization for every repository
 * write (§3.5 / Req 5.6 / Req 5.7), so its core invariants need explicit
 * coverage: FIFO ordering per key, isolation across keys, release after
 * `work()` rejects, and idempotent release callbacks.
 */

import { describe, it, expect } from "vitest";

import {
  createPerConversationMutex,
  GLOBAL_MUTEX_KEY,
} from "./PerConversationMutex.js";

/**
 * Schedule `count` `withLock` tasks against `key` that each push `tag(i)`
 * onto a shared log, then await a `next()` promise the test controls.
 * Returns the array of submitted task promises plus the log.
 *
 * @param {ReturnType<typeof createPerConversationMutex>} mutex
 * @param {string} key
 * @param {number} count
 * @param {(i: number) => string} tag
 */
function scheduleSequential(mutex, key, count, tag) {
  /** @type {string[]} */
  const log = [];
  /** @type {Array<() => void>} */
  const releases = [];
  /** @type {Promise<void>[]} */
  const promises = [];
  for (let i = 0; i < count; i += 1) {
    const taskIndex = i;
    promises.push(
      mutex.withLock(key, async () => {
        log.push(`enter:${tag(taskIndex)}`);
        await new Promise((resolve) => {
          releases[taskIndex] = () => {
            log.push(`exit:${tag(taskIndex)}`);
            resolve();
          };
        });
      }),
    );
  }
  return { promises, releases, log };
}

describe("PerConversationMutex", () => {
  /**
   * Drain enough microtasks for the chained-promise mutex to settle. The
   * chain has multiple `await` boundaries (release → tail update →
   * `await previous` resolves → `work()` runs → push to log), so a single
   * `await Promise.resolve()` is not always enough. Twenty drains is well
   * past the depth this implementation needs.
   */
  async function flush() {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  }

  it("serializes calls for the same key in FIFO submission order", async () => {
    const mutex = createPerConversationMutex();
    const { promises, releases, log } = scheduleSequential(
      mutex,
      "convA",
      3,
      (i) => `t${i}`,
    );
    // Let the first task acquire and start running.
    await flush();
    expect(log).toEqual(["enter:t0"]);

    // Releasing in submission order must drain in FIFO.
    releases[0]();
    await flush();
    expect(log).toEqual(["enter:t0", "exit:t0", "enter:t1"]);

    releases[1]();
    await flush();
    expect(log).toEqual([
      "enter:t0",
      "exit:t0",
      "enter:t1",
      "exit:t1",
      "enter:t2",
    ]);

    releases[2]();
    await Promise.all(promises);
    expect(log).toEqual([
      "enter:t0",
      "exit:t0",
      "enter:t1",
      "exit:t1",
      "enter:t2",
      "exit:t2",
    ]);
  });

  it("does not block work on a different key", async () => {
    const mutex = createPerConversationMutex();
    /** @type {string[]} */
    const log = [];
    /** @type {() => void} */
    let releaseA = () => {};
    const aPromise = mutex.withLock("convA", async () => {
      log.push("A:enter");
      await new Promise((resolve) => {
        releaseA = () => resolve();
      });
      log.push("A:exit");
    });
    // convB should run even though convA has not released yet.
    const bPromise = mutex.withLock("convB", async () => {
      log.push("B:enter-and-exit");
    });
    await bPromise;
    expect(log).toContain("B:enter-and-exit");
    expect(log).not.toContain("A:exit");
    releaseA();
    await aPromise;
    expect(log).toEqual(["A:enter", "B:enter-and-exit", "A:exit"]);
  });

  it("releases the lock when work throws so the next task can run", async () => {
    const mutex = createPerConversationMutex();
    /** @type {string[]} */
    const log = [];
    const failing = mutex.withLock("convA", async () => {
      log.push("first");
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await mutex.withLock("convA", async () => {
      log.push("second");
    });
    expect(log).toEqual(["first", "second"]);
  });

  it("treats null / empty / undefined keys as the global key", async () => {
    const mutex = createPerConversationMutex();
    /** @type {string[]} */
    const log = [];
    /** @type {() => void} */
    let release = () => {};
    const t0 = mutex.withLock(GLOBAL_MUTEX_KEY, async () => {
      log.push("global");
      await new Promise((resolve) => {
        release = () => resolve();
      });
    });
    // Empty string and undefined-as-string-coercion both fall through to
    // the global key; both should queue behind `t0`.
    const t1 = mutex.withLock(
      /** @type {any} */ (""),
      async () => {
        log.push("empty");
      },
    );
    const t2 = mutex.withLock(
      /** @type {any} */ (null),
      async () => {
        log.push("null");
      },
    );
    await flush();
    expect(log).toEqual(["global"]);
    release();
    await Promise.all([t0, t1, t2]);
    expect(log).toEqual(["global", "empty", "null"]);
  });

  it("acquire returns a release callback that is idempotent", async () => {
    const mutex = createPerConversationMutex();
    const release = await mutex.acquire("convA");
    release();
    release(); // second call must not throw or break the chain
    // A fresh acquire should resolve immediately.
    const release2 = await mutex.acquire("convA");
    release2();
  });

  it("cleans up empty key chains so the active key count returns to zero", async () => {
    const mutex = createPerConversationMutex();
    await mutex.withLock("convA", async () => {});
    await mutex.withLock("convB", async () => {});
    // Both chains have drained — internal map should be empty.
    expect(mutex._activeKeyCount()).toBe(0);
  });

  it("preserves submission order across overlapping tasks on the same key", async () => {
    const mutex = createPerConversationMutex();
    /** @type {number[]} */
    const log = [];
    // Submit ten tasks in the same microtask burst — this models a flood of
    // socket events arriving in the same tick (Req 5.6).
    const tasks = [];
    for (let i = 0; i < 10; i += 1) {
      const taskIndex = i;
      tasks.push(
        mutex.withLock("convA", async () => {
          log.push(taskIndex);
        }),
      );
    }
    await Promise.all(tasks);
    expect(log).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
