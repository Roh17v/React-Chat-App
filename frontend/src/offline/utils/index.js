// Pure helper utilities barrel.
//
// - wireFormat.js          (task 2.1 — done)
// - Diagnostics.js         (task 3.1)
// - PerConversationMutex.js (task 7.3)

export { toLocalRow, toWirePayload } from "./wireFormat.js";
export {
  createPerConversationMutex,
  getPerConversationMutex,
  GLOBAL_MUTEX_KEY,
} from "./PerConversationMutex.js";
