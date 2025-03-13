import useAppStore from "@/store";
import { HOST } from "@/utils/constants";
import { io } from "socket.io-client";
import { useRef, useEffect, useState, useMemo } from "react";
import { createContext, useContext } from "react";

const SocketContext = createContext(null);

export const useSocket = () => {
  return useContext(SocketContext);
};

export const SocketProvider = ({ children }) => {
  const socket = useRef(null);
  const { user } = useAppStore();
  const [onlineUsers, setOnlineUsers] = useState([]);
  const { selectedChatData, selectedChatType, addMessage } = useAppStore();

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

      return () => {
        if (socket.current) {
          socket.current.disconnect();
          socket.current = null;
        }
      };
    }
  }, [user]);

  useEffect(() => {
    if (!socket.current) return;

    const handleReceiveMessage = (message) => {
      if (
        selectedChatData &&
        selectedChatType !== undefined &&
        (selectedChatData._id === message.sender._id ||
          selectedChatData._id === message.receiver._id)
      ) {
        addMessage(message);
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
      socket.current.off("receiveMessage", handleReceiveMessage);
      socket.current.off(
        "receive-channel-message",
        handleChannelReceiveMessage
      );
    };
  }, [selectedChatData, selectedChatType]);

  return (
    <SocketContext.Provider value={{ socket: socket.current, onlineUsers }}>
      {children}
    </SocketContext.Provider>
  );
};
