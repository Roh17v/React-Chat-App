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
  incomingCall: null, // { callId, callerId, callType }
  activeCall: null, // { callId, otherUserId, callType }
  pendingNotification: null, // { type, chatType, chatId, callId, callAction }
  callAccepted: false,
  typingIndicators: {},

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
        new Map(allMessages.map((msg) => [msg._id, msg])).values(),
      );

      return { selectedChatMessages: uniqueMessages };
    }),

  addContact: (contact) => {
    const contacts = get().directMessagesContacts || [];
    set({ directMessagesContacts: [...contacts, contact] });
  },

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
  updatedMessageStatus: (receiverId, status) => {
    console.log(receiverId, status);
    set((state) => {
      if (state.selectedChatData?._id === receiverId) {
        return {
          selectedChatMessages: state.selectedChatMessages.map((message) => ({
            ...message,
            status,
          })),
        };
      }
      return {};
    });
  },

  setIncomingCall: (call) => set({ incomingCall: call }),
  clearIncomingCall: () => set({ incomingCall: null }),

  setActiveCall: (call) => set({ activeCall: call }),
  clearActiveCall: () => set({ activeCall: null }),

  setCallAccepted: (accepted = true) => set({ callAccepted: accepted }),
  clearCallAccepted: () => set({ callAccepted: false }),

  setPendingNotification: (payload) => set({ pendingNotification: payload }),
  clearPendingNotification: () => set({ pendingNotification: null }),

  setTypingIndicator: ({ chatId, user, isTyping }) =>
    set((state) => {
      const existingUsers = state.typingIndicators[chatId] || [];
      const hasUser = existingUsers.some(
        (typingUser) => typingUser._id === user._id,
      );
      const nextUsers = isTyping
        ? hasUser
          ? existingUsers
          : [...existingUsers, user]
        : existingUsers.filter((typingUser) => typingUser._id !== user._id);

      return {
        typingIndicators: {
          ...state.typingIndicators,
          [chatId]: nextUsers,
        },
      };
    }),
  clearTypingIndicatorsForChat: (chatId) =>
    set((state) => {
      if (!state.typingIndicators[chatId]) return {};
      const { [chatId]: _removed, ...rest } = state.typingIndicators;
      return { typingIndicators: rest };
    }),
});
