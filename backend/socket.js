import { Server as SocketIoServer } from "socket.io";
import Message from "./models/message.model.js";
import { Channel } from "./models/channel.model.js";

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

  const sendChannelMessage = async (message, socket) => {
    try {
      const { channelId, messageType, content, sender, fileUrl } = message;

      const newMessage = await Message.create({
        sender,
        content,
        messageType,
        receiver: null,
        fileUrl,
        channelId,
      });

      const messageData = await Message.findById(newMessage._id)
        .populate("sender")
        .exec();

      await Channel.findByIdAndUpdate(channelId, {
        $push: { message: newMessage._id },
      });

      const channel = await Channel.findById(channelId).populate("members");

      const finalData = { ...messageData._doc, channelId: channel._id };

      if (channel && channel.members) {
        channel.members.forEach((contact) => {
          const memberSocketId =
            userSocketMap.get(contact._id.toString()) || new Set();
          if (memberSocketId.size > 0) {
            memberSocketId.forEach((socketId) => {
              io.to(socketId).emit("receive-channel-message", finalData);
            });
          }
        });
        const adminSocketId =
          userSocketMap.get(channel.admin.toString()) || new Set();
        if (adminSocketId.size > 0) {
          adminSocketId.forEach((socketId) => {
            io.to(socketId).emit("receive-channel-message", finalData);
          });
        }
      }
    } catch (error) {
      console.log("Error sending messsage: ", error);
    }
  };

  io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;

    if (userId) {
      addUserSocket(userId, socket.id);
      io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      console.log(`User Connected: ${userId} with socket ID: ${socket.id}`);
    } else {
      console.log("User ID not present.");
    }

    socket.on("send-channel-message", (message) =>
      sendChannelMessage(message, socket)
    );

    socket.on("sendMessage", (message) => sendMessage(message, socket));

    socket.on("disconnect", () => {
      removeUserSocket(userId, socket.id);
      io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      console.log(`Client Disconnected: ${socket.id}`);
    });
  });
};

export default setupSocket;
