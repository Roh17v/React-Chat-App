const createAuthSlice = (set) => ({
  user: null,
  isLoading: false,
  authInitialized: false, // Track if initial auth check is complete
  setUser: (userData) => set({ user: userData }),
  setAuthInitialized: (initialized) => set({ authInitialized: initialized }),
  logout: () => set({ 
    user: null,
    directMessagesContacts: [],
    channels: [],
    selectedChatData: undefined,
    selectedChatType: undefined,
    selectedChatMessages: []
  }),
});

export default createAuthSlice;
