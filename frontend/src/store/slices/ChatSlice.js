export const createChatSlice = (set, get) => ({
  selectedChatType: undefined,
  selectedChatData: undefined,
  selectedChatMessages: [],

  setSelectedChatData: (selectedChatData) => set({ selectedChatData }),
  setSelectedChatType: (selectedChatType) => set({ selectedChatType }),
  setSelectedChatMessages: (selectedChatMessages) => set(selectedChatMessages),
  closeChat: () =>
    set({
      selectedChatData: undefined,
      selectedChatType: undefined,
      selectedChatMessages: [],
    }),
});
