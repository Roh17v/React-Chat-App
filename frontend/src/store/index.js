import { create } from "zustand";
import { persist } from "zustand/middleware";
import createAuthSlice from "./slices/AuthSlice.js";

const useAppStore = create((set, get) => ({
  ...createAuthSlice(set, get),
  }
)
);

export default useAppStore;
