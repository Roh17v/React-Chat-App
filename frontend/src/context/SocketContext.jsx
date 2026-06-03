import useAppStore from "@/store";
import { HOST } from "@/utils/constants";
import { io } from "socket.io-client";
import { useRef, useEffect, useState } from "react";
import { createContext, useContext } from "react";
import useMediaStream from "@/hooks/useMediaStream";
import { Capacitor } from "@capacitor/core";
import NativeCallPlugin from "@/plugins/NativeCallPlugin";
import { toast } from "sonner";
import { getSyncEngine } from "@/offline/sync/SyncEngine";

/**
 * Returns true when the SyncEngine singleton exists and has been started
 * (phase !== "idle"). Safe to call even before OfflineProvider wires the
 * singleton — the thrown error is caught and treated as "not ready".
 */
function isSyncEngineReady() {
  try {
    const engine = getSyncEngine();
    return engine.getStatus().phase !== "idle";
  } catch {
    return false;
  }
}

const SocketContext = createContext(null);

// Persist critical call-control signals across temporary socket disconnects.
// Keep only the latest payload per event to stay minimal and low-risk.
const reconnectCallSignalQueue = {
  callEnd: null,
  mediaState: null,
};

export const queueCallEndForReconnect = (payload) => {
  reconnectCallSignalQueue.callEnd = payload || null;
};

export const queueCallMediaStateForReconnect = (payload) => {
  reconnectCallSignalQueue.mediaState = payload || null;
};

const emitReliableWithQueueFallback = (socketInstance, event, payload, queueKey) => {
  if (!socketInstance || !payload) return;

  const queuePayload = () => {
    if (queueKey === "callEnd") reconnectCallSignalQueue.callEnd = payload;
    if (queueKey === "mediaState") reconnectCallSignalQueue.mediaState = payload;
  };

  const emitOnce = () => {
    if (!socketInstance.connected) {
      queuePayload();
      return;
    }
    socketInstance.emit(event, payload);
  };

  emitOnce();
  window.setTimeout(emitOnce, 220);
  window.setTimeout(emitOnce, 900);
};

export const useSocket = () => {
  return useContext(SocketContext);
};

const normalizeId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) {
    return value._id.toString();
  }
  return value.toString();
};

const getFileNameFromUrl = (url) => {
  if (!url) return "File";
  try {
    const parsedUrl = new URL(url);
    const fileName = parsedUrl.pathname.split("/").pop();
    return decodeURIComponent(fileName || "File");
  } catch {
    const fileName = url.split("/").pop();
    return decodeURIComponent(fileName || "File");
  }
};

const getMessagePreview = (message) => {
  if (!message) return "No messages yet";

  if (message.messageType === "text") {
    const trimmed = (message.content || "").trim();
    return trimmed || "Message";
  }

  if (message.messageType === "file") {
    return `Attachment: ${message.fileName || getFileNameFromUrl(message.fileUrl)}`;
  }

  if (message.messageType === "call") {
    return "Call";
  }

  return "Message";
};

export const SocketProvider = ({ children }) => {
  const socket = useRef(null);
  const { user } = useAppStore();
  const [onlineUsers, setOnlineUsers] = useState([]);
  const {
    selectedChatData,
    selectedChatType,
    addMessage,
    addChannel,
    addContact,
    confirmMessage,
    failMessage,
    updatedMessageStatus,
    directMessagesContacts,
    setDirectMessagesContacts,
    setIncomingCall,
    clearIncomingCall,
    setActiveCall,
    clearActiveCall,
    setCallAccepted,
    clearCallAccepted,
    setTypingIndicator,
    updateContactLastSeen,
    replaceWithDeletedPlaceholder,
  } = useAppStore();

  const { stopMedia } = useMediaStream();
  // Auto-expire timers: "chatId_userId" → timeoutId.
  const TYPING_EXPIRE_MS = 5000;
  const typingTimers = useRef({});

  useEffect(() => {
    if (user && !socket.current) {
      socket.current = io(HOST, {
        withCredentials: true,
        query: { userId: user.id },
        transports: ["websocket"],
        // Keep reconnect aggressive for temporary Android/WebView throttling
        // during native call UI transitions.
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.2,
        timeout: 20000,
      });

      const onSocketConnect = () => {
        console.log("Connected to socket server");

        const state = useAppStore.getState();
        const currentActiveCall = state.activeCall;
        const currentCallId = normalizeId(currentActiveCall?.callId);

        const queuedCallEnd = reconnectCallSignalQueue.callEnd;
        if (queuedCallEnd) {
          if (!currentActiveCall) {
            reconnectCallSignalQueue.callEnd = null;
          } else {
          const queuedCallId = normalizeId(queuedCallEnd.callId);
          const isStaleForAnotherCall =
            queuedCallId && currentCallId && queuedCallId !== currentCallId;
          if (isStaleForAnotherCall) {
            reconnectCallSignalQueue.callEnd = null;
          } else {
            emitReliableWithQueueFallback(
              socket.current,
              "call:end",
              queuedCallEnd,
              "callEnd",
            );
            reconnectCallSignalQueue.callEnd = null;
          }
          }
        }

        const queuedMediaState = reconnectCallSignalQueue.mediaState;
        if (queuedMediaState) {
          const queuedCallId = normalizeId(queuedMediaState.callId);
          const shouldEmitForCurrentCall =
            currentActiveCall &&
            (!queuedCallId || !currentCallId || queuedCallId === currentCallId);
          if (shouldEmitForCurrentCall) {
            emitReliableWithQueueFallback(
              socket.current,
              "call:media-state",
              queuedMediaState,
              "mediaState",
            );
          }
          reconnectCallSignalQueue.mediaState = null;
        }

        if (!currentActiveCall) return;

        const currentPeerId = normalizeId(
          currentActiveCall.otherUserId || currentActiveCall.callerId,
        );
        if (!currentCallId && !currentPeerId) return;

        socket.current.emit(
          "call:resync",
          {
            ...(currentCallId ? { callId: currentCallId } : {}),
            ...(currentPeerId ? { peerId: currentPeerId } : {}),
          },
          (result = {}) => {
            const liveState = useAppStore.getState();
            const liveCall = liveState.activeCall;
            if (!liveCall) return;

            const liveCallId = normalizeId(liveCall.callId);
            const livePeerId = normalizeId(
              liveCall.otherUserId || liveCall.callerId,
            );

            // Ignore late resync callbacks for a previous call session.
            if (currentCallId && liveCallId && currentCallId !== liveCallId) return;
            if (currentPeerId && livePeerId && currentPeerId !== livePeerId) return;

            if (!result.active) {
              if (
                Capacitor.isNativePlatform() &&
                liveCall.callType === "video"
              ) {
                NativeCallPlugin.endCall({ notifyRemote: false }).catch(() => { });
              }
              liveState.clearIncomingCall();
              liveState.clearActiveCall();
              liveState.clearCallAccepted();
              return;
            }

            const resyncedCallId = normalizeId(result.callId);
            if (resyncedCallId && resyncedCallId !== liveCallId) {
              liveState.setActiveCall({
                ...liveCall,
                callId: resyncedCallId,
              });
            }

            if ((result.phase || "").toLowerCase() === "connected") {
              liveState.setCallAccepted(true);
            }
          },
        );
      };

      socket.current.on("connect", onSocketConnect);

      socket.current.on("onlineUsers", (users) => {
        setOnlineUsers(users);
      });

      socket.current.on("new-dm-contact", (contact) => {
        addContact(contact);
      });

      socket.current.on("user-profile-updated", (data) => {
        const state = useAppStore.getState();
        const contacts = state.directMessagesContacts || [];
        
        // Update contacts list
        const updatedContacts = contacts.map((c) => 
          c._id.toString() === data.userId.toString() 
            ? { ...c, ...data } 
            : c
        );
        useAppStore.setState({ directMessagesContacts: updatedContacts });
        
        // Also update selected chat if it's the same user!
        const selectedChat = state.selectedChatData;
        if (selectedChat && selectedChat._id.toString() === data.userId.toString()) {
          useAppStore.setState({ selectedChatData: { ...selectedChat, ...data } });
        }
      });

      socket.current.on("message-status-update", ({ receiverId, status }) => {
        console.log("Message Status Update!", ` status: ${status}`);
        if (Capacitor.isNativePlatform() && isSyncEngineReady()) {
          getSyncEngine().applyLiveEvent({
            kind: "message-status-update",
            payload: { receiverId, status },
          });
        } else {
          updatedMessageStatus(receiverId, status);
        }
      });

      socket.current.on("new-channel-contact", (channel) => {
        console.log("New Channel Received: ", channel);
        addChannel(channel);
      });

      socket.current.on("connection-request-received", (data) => {
        toast.info("You received a new connection request!");
      });

      socket.current.on("connection-accepted", (data) => {
        toast.success("Your connection request was accepted!");
      });

      const onCallSession = (session = {}) => {
        const sessionCallId = normalizeId(session.callId);
        const sessionCallerId = normalizeId(session.callerId);
        const sessionReceiverId = normalizeId(session.receiverId);
        if (!sessionCallId || !sessionCallerId || !sessionReceiverId) return;

        const state = useAppStore.getState();
        const currentActiveCall = state.activeCall;
        if (!currentActiveCall) return;
        const currentCallId = normalizeId(currentActiveCall.callId);
        if (currentCallId && currentCallId !== sessionCallId) {
          // Do not let late/unrelated session events override an established call.
          return;
        }

        const currentPeerId = normalizeId(
          currentActiveCall.otherUserId || currentActiveCall.callerId,
        );
        const myUserId = normalizeId(user?.id);
        const isCaller = sessionCallerId === myUserId;
        const peerId = isCaller ? sessionReceiverId : sessionCallerId;

        if (currentPeerId && currentPeerId !== peerId) return;

        const nextCall = {
          ...currentActiveCall,
          callId: sessionCallId,
          callType: session.callType || currentActiveCall.callType,
          isCaller,
          callerId: sessionCallerId,
          receiverId: sessionReceiverId,
          otherUserId: peerId,
        };

        const changed =
          nextCall.callId !== currentActiveCall.callId ||
          nextCall.callType !== currentActiveCall.callType ||
          nextCall.isCaller !== currentActiveCall.isCaller ||
          nextCall.otherUserId !== currentActiveCall.otherUserId;

        if (changed) {
          state.setActiveCall(nextCall);
        }

        state.clearIncomingCall();
      };

      const onIncomingCall = (data = {}) => {
        console.log("Incoming Call Data in Provider:", data);
        const state = useAppStore.getState();
        const currentActiveCall = state.activeCall;
        const callerId = normalizeId(data.callerId);

        if (currentActiveCall) {
          const currentPeerId = normalizeId(
            currentActiveCall.otherUserId || currentActiveCall.callerId,
          );
          const isSamePeer = currentPeerId && currentPeerId === callerId;
          if (isSamePeer) {
            // Simultaneous-call race for same pair: ignore duplicate incoming overlay
            // and allow call:session to reconcile role + callId.
            const incomingCallId = normalizeId(data.callId);
            const shouldUpdateCallId =
              incomingCallId && !normalizeId(currentActiveCall.callId);
            if (shouldUpdateCallId) {
              const myUserId = normalizeId(user?.id);
              const resolvedIsCaller = callerId === myUserId;
              state.setActiveCall({
                ...currentActiveCall,
                callId: incomingCallId,
                isCaller: resolvedIsCaller,
                callerId,
                receiverId:
                  normalizeId(data.receiverId) ||
                  currentActiveCall.receiverId ||
                  myUserId,
              });
            }
            state.clearIncomingCall();
            return;
          }
        }

        const existingIncoming = state.incomingCall;
        if (
          existingIncoming &&
          normalizeId(existingIncoming.callId) === normalizeId(data.callId)
        ) {
          return;
        }

        state.setIncomingCall(data);
      };

      socket.current.on("call:session", onCallSession);
      socket.current.on("incoming-call", onIncomingCall);

      const applyCallConnectedAt = ({ callId, connectedAt, serverNow } = {}) => {
        const parsedConnectedAt = Number(connectedAt);
        const resolvedCallId = normalizeId(callId);
        if (
          (!Number.isFinite(parsedConnectedAt) || parsedConnectedAt <= 0) &&
          !resolvedCallId
        ) {
          return;
        }

        const parsedServerNow = Number(serverNow);
        const hasServerNow =
          Number.isFinite(parsedServerNow) && parsedServerNow > 0;
        const estimatedLocalMinusServerOffset = hasServerNow
          ? Date.now() - parsedServerNow
          : 0;
        const localSynchronizedStart =
          parsedConnectedAt + estimatedLocalMinusServerOffset;
        const normalizedStart = Math.round(localSynchronizedStart);

        const state = useAppStore.getState();
        const currentActiveCall = state.activeCall;
        if (!currentActiveCall) return;
        const currentCallId = normalizeId(currentActiveCall.callId);
        if (currentCallId && resolvedCallId && currentCallId !== resolvedCallId) {
          // Ignore cross-call connected events from stale listeners/races.
          return;
        }

        const shouldUpdateCallId =
          resolvedCallId && currentActiveCall.callId !== resolvedCallId;
        const shouldUpdateStartTime =
          Number.isFinite(parsedConnectedAt) &&
          parsedConnectedAt > 0 &&
          currentActiveCall.callStartedAt !== normalizedStart;
        if (!shouldUpdateCallId && !shouldUpdateStartTime) return;

        state.setActiveCall({
          ...currentActiveCall,
          ...(shouldUpdateCallId ? { callId: resolvedCallId } : {}),
          ...(shouldUpdateStartTime ? { callStartedAt: normalizedStart } : {}),
        });
      };

      socket.current.on("call-accepted", (payload = {}) => {
        applyCallConnectedAt(payload);
        setCallAccepted(true);
      });

      socket.current.on("call-connected", (payload = {}) => {
        applyCallConnectedAt(payload);
      });

      socket.current.on("call-rejected", (payload = {}) => {
        const state = useAppStore.getState();
        const rejectedCallId = normalizeId(payload.callId);
        const activeCallId = normalizeId(state.activeCall?.callId);
        const incomingCallId = normalizeId(state.incomingCall?.callId);

        const matchesCurrentCall =
          !rejectedCallId ||
          rejectedCallId === activeCallId ||
          rejectedCallId === incomingCallId;
        if (!matchesCurrentCall) return;

        clearIncomingCall();
        clearActiveCall();
        clearCallAccepted();
      });

      // When the caller cancels/ends the call (during ringing or active call),
      // the server emits "call:end" to the other party.
      socket.current.on("call:end", (payload = {}) => {
        const state = useAppStore.getState();
        const { activeCall, incomingCall } = state;
        const endedCallId = normalizeId(payload.callId);
        const endedFrom = normalizeId(payload.from);
        const activeCallId = normalizeId(activeCall?.callId);
        const incomingCallId = normalizeId(incomingCall?.callId);
        const activePeerId = normalizeId(
          activeCall?.otherUserId || activeCall?.callerId,
        );
        const incomingPeerId = normalizeId(incomingCall?.callerId);
        const hasIdentifiers = Boolean(endedFrom || endedCallId);

        const matchesIncoming =
          (endedFrom && incomingPeerId && endedFrom === incomingPeerId) ||
          (endedCallId && incomingCallId && endedCallId === incomingCallId) ||
          (!hasIdentifiers && Boolean(incomingCall));
        if (matchesIncoming) {
          clearIncomingCall();
        }

        // Always clear active call on a matching remote hangup.
        // Restricting this to pre-accept states leaves connected calls stuck in
        // "reconnecting" when remote end arrives but native screen does not auto-close.
        const matchesActive =
          (endedFrom && activePeerId && endedFrom === activePeerId) ||
          (endedCallId && activeCallId && endedCallId === activeCallId) ||
          (!hasIdentifiers && Boolean(activeCall));
        if (matchesActive && activeCall) {
          if (
            Capacitor.isNativePlatform() &&
            activeCall.callType === "video"
          ) {
            NativeCallPlugin.endCall({ notifyRemote: false }).catch(() => { });
          }
          clearActiveCall();
          clearCallAccepted();
        }
      });

      socket.current.on("typing", (payload) => {
        const handleTypingFor = (chatId, user) => {
          if (!chatId || !user) return;
          const key = `${chatId}_${user._id}`;
          setTypingIndicator({ chatId, user, isTyping: true });
          // Reset the auto-expire timer on every typing pulse.
          if (typingTimers.current[key]) clearTimeout(typingTimers.current[key]);
          typingTimers.current[key] = setTimeout(() => {
            setTypingIndicator({ chatId, user, isTyping: false });
            delete typingTimers.current[key];
          }, TYPING_EXPIRE_MS);
        };

        if (payload?.chatType === "contact" && payload?.sender) {
          handleTypingFor(payload.senderId, payload.sender);
        }
        if (payload?.chatType === "channel" && payload?.sender) {
          handleTypingFor(payload.channelId, payload.sender);
        }
      });

      socket.current.on("stop-typing", (payload) => {
        const handleStopTypingFor = (chatId, user) => {
          if (!chatId || !user) return;
          const key = `${chatId}_${user._id}`;
          // Cancel the auto-expire — stop-typing arrived cleanly.
          if (typingTimers.current[key]) {
            clearTimeout(typingTimers.current[key]);
            delete typingTimers.current[key];
          }
          setTypingIndicator({ chatId, user, isTyping: false });
        };

        if (payload?.chatType === "contact" && payload?.sender) {
          handleStopTypingFor(payload.senderId, payload.sender);
        }
        if (payload?.chatType === "channel" && payload?.sender) {
          handleStopTypingFor(payload.channelId, payload.sender);
        }
      });

      socket.current.on("user-last-seen", ({ userId, lastSeen }) => {
        updateContactLastSeen(userId, lastSeen);
      });

      socket.current.on("message-deleted", ({ messageId }) => {
        if (Capacitor.isNativePlatform() && isSyncEngineReady()) {
          getSyncEngine().applyLiveEvent({
            kind: "message-deleted",
            payload: { messageId },
          });
        } else {
          if (messageId) {
            replaceWithDeletedPlaceholder(messageId);
          }
        }
      });

      return () => {
        if (socket.current) {
          // Clear all pending auto-expire timers to avoid memory leaks.
          Object.values(typingTimers.current).forEach(clearTimeout);
          typingTimers.current = {};

          socket.current.off("new-dm-contact");
          socket.current.off("new-channel-contact");
          socket.current.off("onlineUsers");
          socket.current.off("connect", onSocketConnect);
          socket.current.off("call:session", onCallSession);
          socket.current.off("incoming-call", onIncomingCall);
          socket.current.off("call-accepted");
          socket.current.off("call-connected");
          socket.current.off("call-rejected");
          socket.current.off("call-ended");
          socket.current.off("call:end");
          socket.current.off("typing");
          socket.current.off("stop-typing");
          socket.current.off("user-last-seen");
          socket.current.off("message-deleted");
          socket.current.off("connection-request-received");
          socket.current.off("connection-accepted");

          socket.current.disconnect();
          socket.current = null;
        }
      };
    }
  }, [
    user,
    addContact,
    addChannel,
    setIncomingCall,
    clearIncomingCall,
    setActiveCall,
    clearActiveCall,
    setCallAccepted,
    clearCallAccepted,
    stopMedia,
    updateContactLastSeen,
  ]);

  useEffect(() => {
    if (!socket.current) return;

    const handleReceiveMessage = (message) => {
      const senderId = normalizeId(message.sender);
      const receiverId = normalizeId(message.receiver);
      const currentUserId = normalizeId(user?.id);
      const selectedChatId = normalizeId(selectedChatData?._id);
      const contactId = senderId === currentUserId ? receiverId : senderId;
      const isIncoming = senderId !== currentUserId;
      const isChatOpen =
        selectedChatType === "contact" && selectedChatId === senderId;

      // --- UI concern: emit confirm-read regardless of platform ---
      if (
        selectedChatData &&
        selectedChatType !== undefined &&
        (selectedChatId === senderId || selectedChatId === receiverId)
      ) {
        if (selectedChatId === senderId) {
          socket.current.emit("confirm-read", {
            userId: user.id,
            senderId: selectedChatId,
          });
        }

        // --- Message-store mutation: native uses SyncEngine, web uses store directly ---
        if (Capacitor.isNativePlatform() && isSyncEngineReady()) {
          getSyncEngine().applyLiveEvent({
            kind: "receiveMessage",
            payload: message,
          });
        } else {
          if (message.clientTempId) {
            confirmMessage(message.clientTempId, message);
          } else {
            addMessage(message);
          }
        }
      } else if (Capacitor.isNativePlatform() && isSyncEngineReady()) {
        // Still persist background messages on native even when the chat isn't open
        getSyncEngine().applyLiveEvent({
          kind: "receiveMessage",
          payload: message,
        });
      }

      // --- UI concern: contact-list update regardless of platform ---
      if (Array.isArray(directMessagesContacts) && contactId) {
        const updatedContacts = [...directMessagesContacts];
        const contactIndex = updatedContacts.findIndex(
          (contact) => normalizeId(contact._id) === contactId,
        );
        const messagePreview = getMessagePreview(message);
        const lastMessageAt = message.createdAt || new Date().toISOString();

        if (contactIndex !== -1) {
          const existingContact = updatedContacts[contactIndex];
          const updatedContact = {
            ...existingContact,
            lastMessage: messagePreview,
            lastMessageAt,
            unreadCount: isIncoming
              ? isChatOpen
                ? 0
                : (existingContact.unreadCount || 0) + 1
              : existingContact.unreadCount || 0,
          };
          updatedContacts.splice(contactIndex, 1);
          updatedContacts.unshift(updatedContact);
          setDirectMessagesContacts(updatedContacts);
        } else {
          const contactPayload =
            senderId === currentUserId ? message.receiver : message.sender;
          if (contactPayload && normalizeId(contactPayload._id)) {
            updatedContacts.unshift({
              ...contactPayload,
              unreadCount: isIncoming && !isChatOpen ? 1 : 0,
              lastMessage: messagePreview,
              lastMessageAt,
            });
            setDirectMessagesContacts(updatedContacts);
          }
        }
      }
    };

    const handleMessageSendFailed = ({ clientTempId }) => {
      if (Capacitor.isNativePlatform() && isSyncEngineReady()) {
        getSyncEngine().applyLiveEvent({
          kind: "messageSendFailed",
          payload: { clientTempId },
        });
      } else {
        if (clientTempId) {
          failMessage(clientTempId);
        }
      }
    };

    const handleChannelReceiveMessage = (message) => {
      if (Capacitor.isNativePlatform() && isSyncEngineReady()) {
        getSyncEngine().applyLiveEvent({
          kind: "receive-channel-message",
          payload: message,
        });
      } else {
        if (selectedChatData && selectedChatType !== undefined) {
          addMessage(message);
        }
      }
      console.log("Channel Message Recieved: ", message);
    };

    socket.current.on("receive-channel-message", handleChannelReceiveMessage);
    socket.current.on("receiveMessage", handleReceiveMessage);
    socket.current.on("messageSendFailed", handleMessageSendFailed);

    return () => {
      if (socket.current) {
        socket.current.off("receiveMessage", handleReceiveMessage);
        socket.current.off("messageSendFailed", handleMessageSendFailed);
        socket.current.off(
          "receive-channel-message",
          handleChannelReceiveMessage,
        );
      }
    };
  }, [selectedChatData, selectedChatType, user, directMessagesContacts]);

  return (
    <SocketContext.Provider value={{ socket: socket.current, onlineUsers }}>
      {children}
    </SocketContext.Provider>
  );
};

