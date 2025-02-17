import { create } from "zustand";
import { persist } from "zustand/middleware";
import createAuthSlice from "./slices/AuthSlice.js";

const useAppStore = create(
  persist(
    (set, get, api) => ({
      ...createAuthSlice(set, get, api),
    }),
    {
      name: "user-storage", // Saves data in localStorage
    }
  )
);

export default useAppStore;
