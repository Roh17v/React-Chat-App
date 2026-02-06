import useAppStore from "@/store";
import { HOST } from "@/utils/constants";
import { io } from "socket.io-client";
import { useRef, useEffect, useState, useMemo } from "react";
import { createContext, useContext } from "react";
import useMediaStream from "@/hooks/useMediaStream";

const SocketContext = createContext(null);

export const useSocket = () => {
  return useContext(SocketContext);
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
      console.log("Inside handle receive message");
      if (
        selectedChatData &&
        selectedChatType !== undefined &&
        (selectedChatData._id === message.sender._id ||
          selectedChatData._id === message.receiver._id)
      ) {
        if (selectedChatData._id === message.sender._id) {
          socket.current.emit("confirm-read", {
            userId: user.id,
            senderId: selectedChatData._id,
          });
        }
        addMessage(message);
      }

      if (directMessagesContacts) {
        const contactIndex = directMessagesContacts.findIndex((contact) => {
          return contact._id === message.sender._id;
        });

        if (
          contactIndex !== -1 &&
          (!selectedChatData || selectedChatData._id !== message.sender._id)
        ) {
          const updatedContacts = [...directMessagesContacts];
          updatedContacts[contactIndex].unreadCount =
            (updatedContacts[contactIndex].unreadCount || 0) + 1;

          const [contact] = updatedContacts.splice(contactIndex, 1);

          updatedContacts.unshift(contact);
          setDirectMessagesContacts(updatedContacts);
          console.log(updatedContacts[contactIndex].unreadCount);
        }
      }
      console.log("Message Received: ", message);
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
