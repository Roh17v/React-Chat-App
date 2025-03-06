import { Server as SocketIoServer } from "socket.io";
import Message from "./models/message.model.js";

const setupSocket = (server) => {
  const io = new SocketIoServer(server, {
    cors: {
      origin: process.env.ORIGIN,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  const userSocketMap = new Map();

  const addUserSocket = (userId, socketId) => {
    if (!userSocketMap.has(userId)) {
      userSocketMap.set(userId, new Set());
    }
    userSocketMap.get(userId).add(socketId);
  };

  const removeUserSocket = (userId, socketId) => {
    if (userSocketMap.has(userId)) {
      const sockets = userSocketMap.get(userId);
      sockets.delete(socketId);
      if (sockets.size === 0) userSocketMap.delete(userId);
    }
  };

  const sendMessage = async (message, socket) => {
    try {
      const createdMessage = await Message.create(message);

      const messageData = await Message.findById(createdMessage._id)
        .populate("sender", "id email firstName lastName image color")
        .populate("receiver", "id email firstName lastName image color");

      const receiverSockets = userSocketMap.get(message.receiver) || new Set();
      const senderSockets = userSocketMap.get(message.sender) || new Set();

      receiverSockets.forEach((socketId) =>
        io.to(socketId).emit("receiveMessage", messageData)
      );
      senderSockets.forEach((socketId) =>
        io.to(socketId).emit("receiveMessage", messageData)
      );
    } catch (error) {
      console.error("Error sending message:", error);
      socket.emit("errorMessage", "Failed to send message");
    }
  };

  io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;

    if (userId) {
      addUserSocket(userId, socket.id);
      console.log(`User Connected: ${userId} with socket ID: ${socket.id}`);
    } else {
      console.log("User ID not present.");
    }

    socket.on("sendMessage", (message) => sendMessage(message, socket));

    socket.on("disconnect", () => {
      console.log(`Client Disconnected: ${socket.id}`);
      removeUserSocket(userId, socket.id);
    });
  });
};

export default setupSocket;
