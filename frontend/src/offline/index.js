// Public offline-store surface. Consumers should import from this barrel
// rather than reaching into subdirectories so the engine can be swapped
// without changing call sites (Requirement 2.3).
//
// `OfflineProvider` is the React glue (task 16.2). `main.jsx` will mount
// it between `<SocketProvider>` and `<App />` in task 16.3.

export {
  getRepository,
  createRepository,
  DB_NAME,
  DEFAULT_MESSAGES_RETENTION_MAX,
  __resetRepositorySingletonForTests,
} from "./repositories/index.js";

export { OfflineProvider } from "./OfflineProvider.jsx";

export {
  createEncryptionLayer,
  getEncryptionLayer,
  __resetEncryptionLayerSingletonForTests,
} from "./services/EncryptionLayer.js";
