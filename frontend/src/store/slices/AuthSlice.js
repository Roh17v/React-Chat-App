import { AUTH_ROUTES, HOST } from "@/utils/constants";
import axios from "axios";
import useAppStore from "..";

const createAuthSlice = (set) => ({
  user: null,
  isLoading: false,
  setUser: (userData) => set({ user: userData }),
  logout: () => set({ user: null }),
});

export default createAuthSlice;
