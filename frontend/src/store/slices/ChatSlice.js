/**
 * Identity keys used to detect the same logical message across local
 * SQLite rows (clientTempId / serverId) and REST payloads (_id). Without
 * multi-key dedup, a slow double-fetch or local+network overlap can render
 * the same bubble twice (temp id + server id).
 *
 * @param {Record<string, any> | null | undefined} msg
 * @returns {string[]}
 */
export const getMessageIdentityKeys = (msg) => {
  if (msg == null || typeof msg !== "object") return [];
  /** @type {string[]} */
  const keys = [];
  const push = (value) => {
    if (value == null || value === "") return;
    const s = String(value);
    if (!keys.includes(s)) keys.push(s);
  };
  push(msg._id);
  push(msg.serverId);
  push(msg.clientTempId);
  return keys;
};

/**
 * Merge two rows that represent the same message. Prefer server-confirmed
 * identity and keep stable UI keys so React does not remount the bubble.
 *
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {Record<string, any>}
 */
export const mergeDuplicateMessages = (a, b) => {
  const aTemp =
    Boolean(a?.isOptimistic) ||
    (typeof a?.clientTempId === "string" &&
      a.clientTempId.length > 0 &&
      String(a._id) === String(a.clientTempId) &&
      (a.serverId == null || a.serverId === ""));
  const bTemp =
    Boolean(b?.isOptimistic) ||
    (typeof b?.clientTempId === "string" &&
      b.clientTempId.length > 0 &&
      String(b._id) === String(b.clientTempId) &&
      (b.serverId == null || b.serverId === ""));

  const primary = aTemp && !bTemp ? b : bTemp && !aTemp ? a : { ...a, ...b };
  const secondary = primary === a ? b : a;
  const serverId = primary.serverId || secondary.serverId || null;
  const clientTempId =
    primary.clientTempId || secondary.clientTempId || null;
  // CRITICAL for "only some chats re-render": keep UI `_id` stable.
  // Prefer clientTempId forever (same rule as toUiMessage). Preferring
  // serverId here flipped React keys (temp → server) when subscription
  // merged after local seed — full list remount, looks like messages
  // "render again", worse on chats where YOU sent messages (they have
  // clientTempId). serverId stays on the row for multi-key dedup.
  const _id =
    (clientTempId != null && String(clientTempId).length > 0
      ? String(clientTempId)
      : null) ||
    (serverId != null && String(serverId).length > 0
      ? String(serverId)
      : null) ||
    (primary._id != null ? String(primary._id) : null) ||
    (secondary._id != null ? String(secondary._id) : null);
  const stableKey =
    a?._stableKey ||
    b?._stableKey ||
    clientTempId ||
    _id;

  // Drop optimistic only once a real server id is present. A status-only
  // snapshot update (pending → sent) on the same temp id must keep
  // `isOptimistic` / `_stableKey` so React does not remount the bubble.
  const isOptimistic =
    serverId != null && String(serverId).length > 0
      ? false
      : Boolean(a?.isOptimistic || b?.isOptimistic);

  return {
    ...secondary,
    ...primary,
    _id,
    serverId,
    clientTempId,
    _stableKey: stableKey,
    isOptimistic,
  };
};

/**
 * Stable React list key for a message bubble. Must not change when a
 * row gains serverId after sync — otherwise the whole list remounts.
 *
 * @param {Record<string, any> | null | undefined} m
 * @returns {string | undefined}
 */
export const getMessageListKey = (m) => {
  if (m == null || typeof m !== "object") return undefined;
  if (m._stableKey != null && String(m._stableKey).length > 0) {
    return String(m._stableKey);
  }
  if (m.clientTempId != null && String(m.clientTempId).length > 0) {
    return String(m.clientTempId);
  }
  if (m.serverId != null && String(m.serverId).length > 0) {
    return String(m.serverId);
  }
  if (m._id != null && String(m._id).length > 0) return String(m._id);
  return undefined;
};
/**
 * Deduplicate a message list by logical identity (_id / serverId /
 * clientTempId), normalize ids to strings, drop deleted-for-me rows,
 * and sort ascending by createdAt.
 *
 * @param {any[]} messages
 * @returns {any[]}
 */
export const dedupeAndSortMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  /** @type {Map<string, number>} */
  const keyToIndex = new Map();
  /** @type {any[]} */
  const result = [];

  for (const raw of messages) {
    if (raw == null || typeof raw !== "object") continue;
    const msg = {
      ...raw,
      _id: raw._id != null && raw._id !== "" ? String(raw._id) : raw._id,
      serverId:
        raw.serverId != null && raw.serverId !== ""
          ? String(raw.serverId)
          : raw.serverId ?? null,
      clientTempId:
        raw.clientTempId != null && raw.clientTempId !== ""
          ? String(raw.clientTempId)
          : raw.clientTempId ?? null,
    };

    const keys = getMessageIdentityKeys(msg);
    let existingIndex = -1;
    for (const k of keys) {
      if (keyToIndex.has(k)) {
        existingIndex = /** @type {number} */ (keyToIndex.get(k));
        break;
      }
    }

    if (existingIndex === -1) {
      const idx = result.length;
      result.push(msg);
      for (const k of keys) keyToIndex.set(k, idx);
      continue;
    }

    const merged = mergeDuplicateMessages(result[existingIndex], msg);
    result[existingIndex] = merged;
    for (const k of getMessageIdentityKeys(merged)) {
      keyToIndex.set(k, existingIndex);
    }
  }

  return result
    .filter((msg) => !msg.deletedForMe)
    .sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
};

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
    set((state) => {
      // Reconcile selectedChatData with the fresh contact so that
      // lastSeen (and other fields) stay in sync when the contacts list
      // is refreshed by incremental sync, bootstrap, or live events.
      // Without this, an already-open chat shows a stale lastSeen until
      // the user navigates away and re-enters the chat.
      if (
        state.selectedChatType === "contact" &&
        state.selectedChatData?._id &&
        Array.isArray(contacts)
      ) {
        const fresh = contacts.find(
          (c) => c._id === state.selectedChatData._id,
        );
        if (fresh) {
          const current = state.selectedChatData;
          // Only update if a visible field actually changed — avoids
          // unnecessary re-renders when the data is identical.
          const changed =
            fresh.lastSeen !== current.lastSeen ||
            fresh.firstName !== current.firstName ||
            fresh.lastName !== current.lastName ||
            fresh.image !== current.image ||
            fresh.color !== current.color;
          if (changed) {
            return {
              directMessagesContacts: contacts,
              selectedChatData: { ...current, ...fresh },
            };
          }
        }
      }
      return { directMessagesContacts: contacts };
    }),
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
    set((state) => {
      // Same conversation re-selected (common on FCM notification tap
      // while the chat is already open, or when contacts refresh re-
      // applies the selected row). Clearing messages here forces an
      // empty→reload flash even though nothing about the conversation
      // identity changed. Only wipe the message window when switching
      // to a different chat (or closing).
      const sameChat =
        selectedChatData?._id != null &&
        state.selectedChatData?._id != null &&
        String(selectedChatData._id) === String(state.selectedChatData._id);
      if (sameChat) {
        return {
          selectedChatData: { ...state.selectedChatData, ...selectedChatData },
          replyToMessage: null,
        };
      }
      return {
        selectedChatData,
        replyToMessage: null,
        selectedChatMessages: [],
      };
    }),
  setSelectedChatType: (selectedChatType) => set({ selectedChatType }),
  showImage: false,
  imageURL: null,
  setShowImage: (showImage) => set({ showImage }),
  setImageURL: (imageURL) => set({ imageURL }),
  setSelectedChatMessages: (newMessages, reset = false) =>
    set((state) => {
      const incoming = Array.isArray(newMessages) ? newMessages : [];
      const allMessages = reset
        ? incoming
        : [...incoming, ...state.selectedChatMessages];

      // Multi-key dedup + sort. Critical for scroll-up pagination under
      // slow networks: two overlapping API pages (or local temp id +
      // server id for the same row) must collapse to one bubble.
      const uniqueMessages = dedupeAndSortMessages(allMessages);

      // Avoid a needless re-render when nothing changed (e.g. a late
      // overlapping page that was entirely absorbed by dedup). Also
      // applies to reset=true when the seed matches live state so
      // chat-open does not remount an identical window.
      if (
        uniqueMessages.length === state.selectedChatMessages.length &&
        uniqueMessages.every(
          (m, i) =>
            m === state.selectedChatMessages[i] ||
            (m &&
              state.selectedChatMessages[i] &&
              String(m._id) === String(state.selectedChatMessages[i]._id) &&
              String(m.serverId || "") ===
                String(state.selectedChatMessages[i].serverId || "") &&
              m.status === state.selectedChatMessages[i].status &&
              m.content === state.selectedChatMessages[i].content &&
              m.deletedForEveryone ===
                state.selectedChatMessages[i].deletedForEveryone),
        )
      ) {
        return state;
      }

      return { selectedChatMessages: uniqueMessages };
    }),

  /**
   * Merge a fresh "newest 50" snapshot from the repository's
   * `subscribeMessages` callback into the live chat window.
   *
   * Why not a destructive `setSelectedChatMessages(snapshot, true)`:
   *   the live window can hold older rows the user paged in, plus
   *   optimistic placeholders. Resetting would kick them out.
   *
   * Identity is multi-key (`_id` / `serverId` / `clientTempId`), not
   * bare `_id`. On FCM chat-open the local seed, live subscription, and
   * socket path can each introduce the same logical message under a
   * different key for a few hundred ms — a single-key merge used to
   * treat those as distinct rows (user saw every bubble twice) until a
   * later `setSelectedChatMessages` multi-key dedupe collapsed them
   * (duplicates "vanished by themselves").
   *
   * Implementation: concatenate current + snapshot and run
   * {@link dedupeAndSortMessages}, which merges status/content via
   * {@link mergeDuplicateMessages} and keeps older paged-in rows that
   * are not in the snapshot.
   *
   * @param {Array<Record<string, any>>} snapshot
   */
  applySubscriptionSnapshot: (snapshot) =>
    set((state) => {
      if (!Array.isArray(snapshot) || snapshot.length === 0) {
        return state;
      }
      const current = state.selectedChatMessages;
      // Snapshot last so live status/content wins on identity collision.
      const next = dedupeAndSortMessages([...current, ...snapshot]);

      if (
        next.length === current.length &&
        next.every(
          (m, i) =>
            m === current[i] ||
            (m &&
              current[i] &&
              String(m._id) === String(current[i]._id) &&
              m.status === current[i].status &&
              m.content === current[i].content &&
              m.deletedForEveryone === current[i].deletedForEveryone &&
              m.deletedForMe === current[i].deletedForMe &&
              String(m.serverId || "") === String(current[i].serverId || "")),
        )
      ) {
        return state;
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
    if (message.deletedForMe) return;
    set((state) => {
      const selectedChatType = state.selectedChatType;
      const incoming = {
        ...message,
        _id: message?._id != null ? String(message._id) : message?._id,
        receiver:
          selectedChatType === "channel"
            ? message.receiver
            : message.receiver?._id ?? message.receiver,
        sender:
          selectedChatType === "channel"
            ? message.sender
            : message.sender?._id ?? message.sender,
      };
      // Always multi-key dedupe — never blind-append. Socket delivery
      // racing a local seed (common on FCM open) used to create a twin.
      const next = dedupeAndSortMessages([
        ...state.selectedChatMessages,
        incoming,
      ]);
      if (
        next.length === state.selectedChatMessages.length &&
        next[next.length - 1] &&
        state.selectedChatMessages.some(
          (m) =>
            m &&
            getMessageIdentityKeys(m).some((k) =>
              getMessageIdentityKeys(incoming).includes(k),
            ),
        )
      ) {
        // Message already present (possibly field-updated). Only skip
        // the write when the list is referentially unchanged enough.
        if (
          next.every(
            (m, i) =>
              m === state.selectedChatMessages[i] ||
              (m &&
                state.selectedChatMessages[i] &&
                String(m._id) === String(state.selectedChatMessages[i]._id) &&
                m.status === state.selectedChatMessages[i].status &&
                m.content === state.selectedChatMessages[i].content),
          )
        ) {
          return state;
        }
      }
      return { selectedChatMessages: next };
    });
  },

  // Instantly inject a client-generated placeholder before the server responds.
  addOptimisticMessage: (message) => {
    set((state) => {
      const incoming = { ...message, _stableKey: message._id };
      return {
        selectedChatMessages: dedupeAndSortMessages([
          ...state.selectedChatMessages,
          incoming,
        ]),
      };
    });
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
      // Zustand only skips subscribers when the same state reference is
      // returned. `return {}` still does Object.assign({}, state, {}) and
      // notifies every listener — which re-rendered MessageContainer on
      // every typing heartbeat. Always `return state` for a true no-op.
      if (!chatId || !user?._id) return state;
      const existingUsers = state.typingIndicators[chatId] || [];
      const hasUser = existingUsers.some(
        (typingUser) => String(typingUser._id) === String(user._id),
      );
      if (isTyping && hasUser) return state;
      if (!isTyping && !hasUser) return state;

      const nextUsers = isTyping
        ? [...existingUsers, user]
        : existingUsers.filter(
            (typingUser) => String(typingUser._id) !== String(user._id),
          );

      return {
        typingIndicators: {
          ...state.typingIndicators,
          [chatId]: nextUsers,
        },
      };
    }),
  clearTypingIndicatorsForChat: (chatId) =>
    set((state) => {
      if (!state.typingIndicators[chatId]) return state;
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
