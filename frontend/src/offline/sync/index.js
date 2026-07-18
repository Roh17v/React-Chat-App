// Sync layer barrel. Concrete modules land in subsequent tasks:
// - SyncEngine.js              (task 11.1)
// - bootstrap.js / incremental.js (task 11.2)
// - OutboundQueue.js           (task 10.1) ← landed
// - clientTempIdRegistry.js    (task 10.2) ← landed
// - conflictResolver.js        (task 8.1)
// - statusLifecycle.js         (task 8.2)

export {
  STATUS_RANK,
  rank,
  monotonicMaxStatus,
} from "./statusLifecycle.js";

export {
  createOutboundQueue,
  getOutboundQueue,
  __resetOutboundQueueSingletonForTests,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  DEFAULT_TIMER_INTERVAL_MS,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  IN_FLIGHT_STUCK_MS,
} from "./OutboundQueue.js";

export {
  createClientTempIdRegistry,
  getClientTempIdRegistry,
  __resetClientTempIdRegistryForTests,
  DEFAULT_TIMEOUT_MS as CLIENT_TEMP_ID_DEFAULT_TIMEOUT_MS,
} from "./clientTempIdRegistry.js";
