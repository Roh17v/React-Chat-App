import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the frontend package.
 *
 * The offline-support feature spans two execution environments:
 *
 *   1. Node — repository / migrator / queue / sync logic exercised with the
 *      `better-sqlite3` test driver (see `src/offline/db/drivers/sqlite.testDriver.js`,
 *      task 5.2). These tests must NOT load jsdom because `better-sqlite3` is a
 *      native Node addon and jsdom adds noise + slow startup.
 *
 *   2. jsdom — React component / hook tests (`OfflineProvider`, message UI
 *      wiring, etc.) need a DOM.
 *
 * `environmentMatchGlobs` lets each test file pick the right environment by
 * filename convention without per-file `// @vitest-environment` headers.
 *
 * Conventions:
 *   - `*.node.test.{js,jsx}`            → node
 *   - `*.dom.test.{js,jsx}`             → jsdom
 *   - tests under `src/offline/db/**`,
 *     `src/offline/repositories/**`,
 *     `src/offline/sync/**`,
 *     `src/offline/services/**`,
 *     `src/offline/utils/**`            → node (pure logic / SQLite)
 *   - everything else                    → jsdom (default)
 *
 * Property-based tests (`*.property.test.js`) inherit the same matching as
 * regular tests; place them next to the module they validate.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    environmentMatchGlobs: [
      ["src/offline/db/**", "node"],
      ["src/offline/repositories/**", "node"],
      ["src/offline/sync/**", "node"],
      ["src/offline/services/**", "node"],
      ["src/offline/utils/**", "node"],
      ["**/*.node.test.{js,jsx}", "node"],
      ["**/*.dom.test.{js,jsx}", "jsdom"],
    ],
    include: ["src/**/*.{test,property.test}.{js,jsx}"],
    exclude: ["node_modules", "dist", "android", "ios"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/offline/**/*.{js,jsx}"],
      exclude: [
        "src/offline/**/*.test.{js,jsx}",
        "src/offline/**/*.property.test.{js,jsx}",
        "src/offline/**/index.js",
      ],
    },
  },
});
