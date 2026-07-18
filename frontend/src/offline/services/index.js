// Cross-cutting services barrel. Implementations land in later tasks:
// - EncryptionLayer.js (task 4.1)
// - Connectivity.js    (task 12.1)
// - MediaCache.js      (task 13.1)
export {
  createConnectivity,
  getConnectivity,
  SOCKET_EVENT_WINDOW_MS,
  __resetConnectivitySingletonForTests,
} from "./Connectivity.js";

export {
  createMediaCache,
  getMediaCache,
  MAX_DOWNLOAD_ATTEMPTS,
  BACKOFF_BASE_MS as MEDIA_BACKOFF_BASE_MS,
  BACKOFF_CAP_MS as MEDIA_BACKOFF_CAP_MS,
  BACKOFF_JITTER_FRACTION as MEDIA_BACKOFF_JITTER_FRACTION,
  EVICTION_COOLDOWN_MS,
  DEFAULT_EVICTION_INTERVAL_MS,
  DEFAULT_MEDIA_BUDGET_BYTES,
  DEFAULT_MEDIA_AUTO_DOWNLOAD_MAX_BYTES,
  MEDIA_DIRECTORY,
  MEDIA_CACHE_PATH,
  MEDIA_PROFILE_PATH,
  __resetMediaCacheSingletonForTests,
} from "./MediaCache.js";
