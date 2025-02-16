import { create } from "zustand";
import createAuthSlice from "./slices/AuthSlice.js";

const useAppStore = create((...a) => ({
  ...createAuthSlice(...a),
}));

export default useAppStore;
