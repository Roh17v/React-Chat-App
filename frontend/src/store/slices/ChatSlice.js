export const createChatSlice = (set, get) => ({
  selectedChatType: undefined,
  selectedChatData: undefined,
  selectedChatMessages: [],
  directMessagesContacts: [],
  isUploading: false,
  isDownloading: false,
  fileUploadingProgress: 0,
  fileDownloadingProgress: 0,
  channels: [],
  messageContainerRef: null,
  page: 1,

  setPage: (pageNo) => set({ page: pageNo }),
  setMessageContainerRef: (ref) => {
    set({ messageContainerRef: ref });
  },
  setChannels: (channels) => set({ channels }),
  setIsUploading: (isUploading) => set({ isUploading }),
  setIsDownloading: (isDownloading) => set({ isDownloading }),
  setFileUploadingProgress: (fileUploadingProgress) =>
    set({ fileUploadingProgress }),
  setFileDownloadingProgress: (fileDownloadingProgress) =>
    set({ fileDownloadingProgress }),
  setDirectMessagesContacts: (contacts) =>
    set({ directMessagesContacts: contacts }),
  setSelectedChatData: (selectedChatData) => set({ selectedChatData }),
  setSelectedChatType: (selectedChatType) => set({ selectedChatType }),
  setSelectedChatMessages: (newMessages, reset = false) =>
    set((state) => {
      const allMessages = reset
        ? newMessages
        : [...newMessages, ...state.selectedChatMessages];

      const uniqueMessages = Array.from(
        new Map(allMessages.map((msg) => [msg._id, msg])).values()
      );

      return { selectedChatMessages: uniqueMessages };
    }),

  addChannel: (channel) => {
    console.log("Inside Add channel");
    const channels = get().channels || [];
    set({ channels: [...channels, channel] });
    console.log(get().channels);
  },
  closeChat: () =>
    set({
      selectedChatData: undefined,
      selectedChatType: undefined,
      selectedChatMessages: [],
    }),
  addMessage: (message) => {
    console.log("Inside add message");
    const { selectedChatMessages, selectedChatType } = get();
    set({
      selectedChatMessages: [
        ...selectedChatMessages,
        {
          ...message,
          receiver:
            selectedChatType === "channel"
              ? message.receiver
              : message.receiver._id,
          sender:
            selectedChatType === "channel"
              ? message.sender
              : message.sender._id,
        },
      ],
    });
  },
});
