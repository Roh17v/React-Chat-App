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
  pendingShareData: null, // { text, fileUrl }

  setPendingShareData: (data) => set({ pendingShareData: data }),
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
    set({ selectedChatData, replyToMessage: null, selectedChatMessages: [] }),
  setSelectedChatType: (selectedChatType) => set({ selectedChatType }),
  showImage: false,
  imageURL: null,
  setShowImage: (showImage) => set({ showImage }),
  setImageURL: (imageURL) => set({ imageURL }),
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

  /**
   * Merge a fresh "newest 50" snapshot from the repository's
   * `subscribeMessages` callback into the live chat window.
   *
   * Why a dedicated merge (not `setSelectedChatMessages(..., true)`):
   *   the live chat window can hold messages that are NOT in the
   *   snapshot — older messages the user paged in via scroll-up, plus
   *   optimistic local-only messages waiting for server confirmation.
   *   A destructive reset (`reset=true`) destroys both of those on
   *   every DB write, which (a) kicks the user back to the newest 50
   *   when a live socket / read receipt / periodic sync fires while
   *   they are scrolled up, and (b) can drop optimistic placeholders.
   *
   * What this merge does, in order:
   *   1. In-place field updates — for any message that exists in both
   *      the state and the snapshot, take the snapshot's `status`,
   *      `deletedForEveryone`, and `content` (the fields a live write
   *      can change) while preserving UI-only fields on the state row
   *      (`_stableKey`, `isOptimistic`, locally-edited `content`, …).
   *   2. New tail messages — messages in the snapshot whose
   *      `createdAt` is newer than the state's tail are appended.
   *   3. New older messages — messages older than the state's head are
   *      prepended (this happens when a periodic sync catches the user
   *      up on offline backlog, e.g. they were offline and a peer sent
   *      several messages in a row, then they came back online).
   *   4. New middle messages — anything in between is inserted at the
   *      correct ascending slot.
   *   5. Messages in the state but NOT in the snapshot are kept
   *      as-is — they're either paginated-in older history, optimistic
   *      placeholders the server hasn't confirmed yet, or messages
   *      whose content was cleared by a deletion the snapshot doesn't
   *      re-surface (the in-place update at step 1 covers the
   *      `deletedForEveryone` / `content` re-clearing case).
   *
   * No-op when nothing changed: returns `{}` so Zustand doesn't trigger
   * a re-render.
   *
   * @param {Array<{_id: string, createdAt?: string, status?: string, content?: string|null, deletedForEveryone?: boolean}>} snapshot
   */
  applySubscriptionSnapshot: (snapshot) =>
    set((state) => {
      if (!Array.isArray(snapshot) || snapshot.length === 0) {
        return {};
      }
      const current = state.selectedChatMessages;
      const snapById = new Map(snapshot.map((m) => [m._id, m]));
      const currentIds = new Set(current.map((m) => m._id));

      // 1. In-place field updates.
      let hasUpdates = false;
      const merged = current.map((m) => {
        const snap = snapById.get(m._id);
        if (snap == null) return m;
        const nextStatus =
          snap.status != null && snap.status !== m.status
            ? snap.status
            : m.status;
        const nextDeleted =
          snap.deletedForEveryone === true
            ? true
            : snap.deletedForEveryone === false
              ? false
              : m.deletedForEveryone;
        const nextContent =
          snap.content !== undefined && snap.content !== m.content
            ? snap.content
            : m.content;
        if (
          nextStatus !== m.status ||
          nextDeleted !== m.deletedForEveryone ||
          nextContent !== m.content
        ) {
          hasUpdates = true;
          return {
            ...m,
            status: nextStatus,
            deletedForEveryone: nextDeleted,
            content: nextContent,
          };
        }
        return m;
      });

      // 2-4. New messages (in snapshot, not in state). Bucket by position
      // relative to the existing window so the merge is O(n+m) instead
      // of O(n*m).
      const newOnes = snapshot.filter((m) => !currentIds.has(m._id));
      if (newOnes.length === 0) {
        return hasUpdates ? { selectedChatMessages: merged } : {};
      }

      const stateOldest = merged[0]?.createdAt;
      const stateNewest = merged[merged.length - 1]?.createdAt;
      const cmp = (a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

      const older = [];
      const newer = [];
      const middle = [];
      for (const m of newOnes) {
        if (typeof m.createdAt !== "string") {
          // No createdAt — treat as a tail append (defensive: never lose
          // a message just because the payload is malformed).
          newer.push(m);
          continue;
        }
        if (stateOldest != null && m.createdAt < stateOldest) {
          older.push(m);
        } else if (stateNewest != null && m.createdAt > stateNewest) {
          newer.push(m);
        } else {
          middle.push(m);
        }
      }

      older.sort(cmp);
      newer.sort(cmp);

      let next = merged;
      if (older.length > 0) next = [...older, ...next];
      if (newer.length > 0) next = [...next, ...newer];
      // Middle: insert each in its sorted slot. O(n) per insert is fine
      // — middle buckets are small in practice (offline sync rare).
      for (const m of middle) {
        const idx = next.findIndex((sm) => sm.createdAt > m.createdAt);
        if (idx === -1) next.push(m);
        else next.splice(idx, 0, m);
      }

      return { selectedChatMessages: next };
    }),

  addContact: (contact) => {
    const contacts = get().directMessagesContacts || [];
    const exists = contacts.some((c) => c._id.toString() === contact._id.toString());
    if (!exists) {
      set({ directMessagesContacts: [...contacts, contact] });
    }
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
    const { selectedChatMessages, selectedChatType } = get();
    set({
      selectedChatMessages: [
        ...selectedChatMessages,
        {
          ...message,
          receiver:
            selectedChatType === "channel"
              ? message.receiver
              : message.receiver?._id ?? message.receiver,
          sender:
            selectedChatType === "channel"
              ? message.sender
              : message.sender?._id ?? message.sender,
        },
      ],
    });
  },

  // Instantly inject a client-generated placeholder before the server responds.
  addOptimisticMessage: (message) => {
    const { selectedChatMessages } = get();
    set({ selectedChatMessages: [...selectedChatMessages, { ...message, _stableKey: message._id }] });
  },

  // Swap the optimistic placeholder with the real server-confirmed message.
  confirmMessage: (tempId, realMessage) => {
    const { selectedChatMessages, selectedChatType } = get();
    set({
      selectedChatMessages: selectedChatMessages.map((msg) => {
        if (msg._id !== tempId) return msg;
        return {
          ...realMessage,
          receiver:
            selectedChatType === "channel"
              ? realMessage.receiver
              : realMessage.receiver?._id ?? realMessage.receiver,
          sender:
            selectedChatType === "channel"
              ? realMessage.sender
              : realMessage.sender?._id ?? realMessage.sender,
          isOptimistic: false,
          _stableKey: msg._stableKey || tempId,
        };
      }),
    });
  },

  // Mark an optimistic placeholder as failed if the server couldn't save it.
  failMessage: (tempId) => {
    set((state) => ({
      selectedChatMessages: state.selectedChatMessages.map((msg) =>
        msg._id === tempId ? { ...msg, status: "failed" } : msg,
      ),
    }));
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
      console.log("ChatSlice.deleteMessageForMe called with messageId:", messageId);
      const filtered = state.selectedChatMessages.filter((msg) => {
        const keep = msg._id !== messageId && msg.serverId !== messageId && msg.clientTempId !== messageId;
        if (!keep) {
          console.log("Filtered out message from state:", msg);
        }
        return keep;
      });
      console.log("Old length:", state.selectedChatMessages.length, "New length:", filtered.length);
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
        msg._id === messageId || msg.serverId === messageId || msg.clientTempId === messageId
          ? { ...msg, deletedForEveryone: true, content: null, fileUrl: null }
          : msg
      );
      // Update sidebar preview if the deleted msg was the last one
      const lastMsg = updatedMessages[updatedMessages.length - 1];
      const isLastDeleted = lastMsg?._id === messageId || lastMsg?.serverId === messageId || lastMsg?.clientTempId === messageId;
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
