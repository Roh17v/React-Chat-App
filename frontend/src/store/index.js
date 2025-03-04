import { create } from "zustand";
import createAuthSlice from "./slices/AuthSlice.js";
import { createChatSlice } from "./slices/ChatSlice.js";

export const useAppStore = create()((...a) => ({
  ...createAuthSlice(...a),
  ...createChatSlice(...a),
}));

export default useAppStore;
