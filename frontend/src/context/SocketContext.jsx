import useAppStore from "@/store";
import { HOST } from "@/utils/constants";
import { io } from "socket.io-client";
import { useRef, useEffect, useState } from "react";
import { createContext, useContext } from "react";
import useMediaStream from "@/hooks/useMediaStream";

const SocketContext = createContext(null);

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
    return `Attachment: ${getFileNameFromUrl(message.fileUrl)}`;
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
  } = useAppStore();

  const { stopMedia } = useMediaStream();

  useEffect(() => {
    if (user && !socket.current) {
      socket.current = io(HOST, {
        withCredentials: true,
        query: { userId: user.id },
      });

      socket.current.on("connect", () => {
        console.log("Connected to socket server");
      });

      socket.current.on("onlineUsers", (users) => {
        setOnlineUsers(users);
      });

      socket.current.on("new-dm-contact", (contact) => {
        addContact(contact);
      });

      socket.current.on("message-status-update", ({ receiverId, status }) => {
        console.log("Message Status Update!", ` status: ${status}`);
        updatedMessageStatus(receiverId, status);
      });

      socket.current.on("new-channel-contact", (channel) => {
        console.log("New Channel Received: ", channel);
        addChannel(channel);
      });

      socket.current.on("incoming-call", (data) => {
        console.log("📞 Incoming Call Data in Provider:", data);
        setIncomingCall(data);
      });

      socket.current.on("call-accepted", () => {
        setCallAccepted(true);
      });

      socket.current.on("call-rejected", () => {
        clearIncomingCall();
        clearActiveCall();
        clearCallAccepted();
      });

      socket.current.on("call-ended", () => {
        stopMedia();
        clearIncomingCall();
        clearActiveCall();
        clearCallAccepted();
      });

      socket.current.on("typing", (payload) => {
        if (payload?.chatType === "contact") {
          setTypingIndicator({
            chatId: payload.senderId,
            user: payload.sender,
            isTyping: true,
          });
        }

        if (payload?.chatType === "channel") {
          setTypingIndicator({
            chatId: payload.channelId,
            user: payload.sender,
            isTyping: true,
          });
        }
      });

      socket.current.on("stop-typing", (payload) => {
        if (payload?.chatType === "contact") {
          setTypingIndicator({
            chatId: payload.senderId,
            user: payload.sender,
            isTyping: false,
          });
        }

        if (payload?.chatType === "channel") {
          setTypingIndicator({
            chatId: payload.channelId,
            user: payload.sender,
            isTyping: false,
          });
        }
      });

      socket.current.on("user-last-seen", ({ userId, lastSeen }) => {
        updateContactLastSeen(userId, lastSeen);
      });

      return () => {
        if (socket.current) {
          socket.current.off("new-dm-contact");
          socket.current.off("new-channel-contact");
          socket.current.off("onlineUsers");
          socket.current.off("incoming-call");
          socket.current.off("call-accepted");
          socket.current.off("call-rejected");
          socket.current.off("call-ended");
          socket.current.off("typing");
          socket.current.off("stop-typing");
          socket.current.off("user-last-seen");

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
        addMessage(message);
      }

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

    const handleChannelReceiveMessage = (message) => {
      if (selectedChatData && selectedChatType !== undefined) {
        addMessage(message);
      }
      console.log("Channel Message Recieved: ", message);
    };

    socket.current.on("receive-channel-message", handleChannelReceiveMessage);

    socket.current.on("receiveMessage", handleReceiveMessage);

    return () => {
      if (socket.current) {
        socket.current.off("receiveMessage", handleReceiveMessage);
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
