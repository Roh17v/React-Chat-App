// SQLite driver implementations land here.
// - sqlite.driver.js (Capacitor `@capacitor-community/sqlite` adapter)  - task 5.1
// - sqlite.testDriver.js (Node-side `better-sqlite3` shim used by tests) - task 5.2
export {
  createSqliteDriver,
  getSqliteDriver,
  __resetSqliteDriverSingletonForTests,
} from "./sqlite.driver.js";
export { createTestSqliteDriver } from "./sqlite.testDriver.js";
