const createAuthSlice = (set) => ({
  user: null,
  isLoading: false,
  authInitialized: false, // Track if initial auth check is complete
  setUser: (userData) => set({ user: userData }),
  setAuthInitialized: (initialized) => set({ authInitialized: initialized }),
  logout: () => set({ user: null }),
});

export default createAuthSlice;
