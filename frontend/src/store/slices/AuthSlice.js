const createAuthSlice = (set) => ({
  user: null,
  isLoading: false,
  setUser: (userData) => set({ user: userData }),
  logout: () => set({ user: null }),
});

export default createAuthSlice;
