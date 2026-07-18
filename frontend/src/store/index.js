import { create } from "zustand";
import createAuthSlice from "./slices/AuthSlice.js";
import { createChatSlice } from "./slices/ChatSlice.js";
import createOfflineSlice from "./slices/OfflineSlice.js";

export const useAppStore = create()((...a) => ({
  ...createAuthSlice(...a),
  ...createChatSlice(...a),
  ...createOfflineSlice(...a),
}));

export default useAppStore;
