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
  isCallMinimized: false,
  typingIndicators: {},
  replyToMessage: null,
  showAvatarPreview: false,
  messageActionMenu: null, // { message, isSent }

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
  resetUnreadCount: (contactId) =>
    set((state) => {
      if (!contactId || !state.directMessagesContacts) return {};
      const updated = state.directMessagesContacts.map((contact) =>
        contact._id === contactId
          ? { ...contact, unreadCount: 0 }
          : contact,
      );
      return { directMessagesContacts: updated };
    }),
  setSelectedChatData: (selectedChatData) =>
    set({ selectedChatData, replyToMessage: null }),
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
      replyToMessage: null,
      showAvatarPreview: false,
      messageActionMenu: null,
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
  updateContactLastSeen: (userId, lastSeen) =>
    set((state) => {
      let updatedContacts = state.directMessagesContacts;
      if (updatedContacts && updatedContacts.length > 0) {
        updatedContacts = updatedContacts.map((contact) =>
          contact._id === userId ? { ...contact, lastSeen } : contact,
        );
      }

      const selectedChatData =
        state.selectedChatData?._id === userId
          ? { ...state.selectedChatData, lastSeen }
          : state.selectedChatData;

      return {
        directMessagesContacts: updatedContacts,
        selectedChatData,
      };
    }),

  setIncomingCall: (call) => set({ incomingCall: call }),
  clearIncomingCall: () => set({ incomingCall: null }),

  setActiveCall: (call) => set({ activeCall: call }),
  clearActiveCall: () => set({ activeCall: null, isCallMinimized: false }),

  setCallAccepted: (accepted = true) => set({ callAccepted: accepted }),
  clearCallAccepted: () => set({ callAccepted: false }),
  setCallMinimized: (minimized) => set({ isCallMinimized: minimized }),

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
  setReplyToMessage: (message) => set({ replyToMessage: message }),
  clearReplyToMessage: () => set({ replyToMessage: null }),
  setShowAvatarPreview: (show) => set({ showAvatarPreview: show }),
  setMessageActionMenu: (menu) => set({ messageActionMenu: menu }),
  deleteMessageForMe: (messageId) =>
    set((state) => {
      const filtered = state.selectedChatMessages.filter(
        (msg) => msg._id !== messageId
      );
      // Update sidebar preview if the deleted msg was the last one
      const lastMsg = filtered[filtered.length - 1];
      const contacts = state.directMessagesContacts?.map((c) => {
        if (c.lastMessage && c._id === state.selectedChatData?._id) {
          return {
            ...c,
            lastMessage: lastMsg
              ? lastMsg.messageType === "text"
                ? lastMsg.content || "Message"
                : "Attachment"
              : "No messages yet",
          };
        }
        return c;
      });
      return {
        selectedChatMessages: filtered,
        ...(contacts && { directMessagesContacts: contacts }),
      };
    }),
  replaceWithDeletedPlaceholder: (messageId) =>
    set((state) => {
      const updatedMessages = state.selectedChatMessages.map((msg) =>
        msg._id === messageId
          ? { ...msg, deletedForEveryone: true, content: null, fileUrl: null }
          : msg
      );
      // Update sidebar preview if the deleted msg was the last one
      const lastMsg = updatedMessages[updatedMessages.length - 1];
      const isLastDeleted = lastMsg?._id === messageId;
      const contacts = isLastDeleted
        ? state.directMessagesContacts?.map((c) => {
            if (c._id === state.selectedChatData?._id) {
              return { ...c, lastMessage: "This message was deleted" };
            }
            return c;
          })
        : state.directMessagesContacts;
      return {
        selectedChatMessages: updatedMessages,
        ...(contacts && { directMessagesContacts: contacts }),
      };
    }),
});
