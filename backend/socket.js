import { Server as SocketIoServer } from "socket.io";
import Message from "./models/message.model.js";
import { Channel } from "./models/channel.model.js";
import { User } from "./models/user.model.js";
import Call from "./models/call.model.js";

let io;
let userSocketMap;

const setupSocket = (server) => {
  io = new SocketIoServer(server, {
    cors: {
      origin: [
        process.env.FRONTEND_URL,
        "http://localhost:5173",
        "http://localhost",       
        "https://localhost",      
        "capacitor://localhost"   
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  userSocketMap = new Map();

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
      const createdMessage = await Message.create({
        ...message,
        status: "sent",
      });

      const messageData = await Message.findById(createdMessage._id)
        .populate("sender", "id email firstName lastName image color")
        .populate("receiver", "id email firstName lastName image color");

      const receiverSockets = userSocketMap.get(message.receiver) || new Set();
      const senderSockets = userSocketMap.get(message.sender) || new Set();

      const receiver = await User.findById(message.receiver);
      if (!receiver.contacts.includes(message.sender)) {
        await User.findByIdAndUpdate(message.receiver, {
          $addToSet: { contacts: message.sender },
        });

        receiverSockets.forEach((socketId) =>
          io.to(socketId).emit("new-dm-contact", messageData.sender),
        );
      }

      const sender = await User.findById(message.sender);
      if (!sender.contacts.includes(message.receiver)) {
        await User.findByIdAndUpdate(message.sender, {
          $addToSet: { contacts: message.receiver },
        });

        senderSockets.forEach((socketId) =>
          io.to(socketId).emit("new-dm-contact", messageData.receiver),
        );
      }

      if (receiverSockets.size > 0) {
        messageData.status = "delivered";
        await messageData.save();

        senderSockets.forEach((socketId) =>
          io.to(socketId).emit("receiveMessage", messageData),
        );

        receiverSockets.forEach((socketId) =>
          io.to(socketId).emit("receiveMessage", messageData),
        );
      } else {
        senderSockets.forEach((socketId) =>
          io.to(socketId).emit("receiveMessage", messageData),
        );
      }
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

  const updateMessageStatusToRead = async ({ userId, senderId }) => {
    try {
      const updatedMessages = await Message.updateMany(
        { receiver: userId, sender: senderId, status: "delivered" },
        { $set: { status: "read" } },
      );
      if (updatedMessages.modifiedCount > 0) {
        const senderSockets = userSocketMap.get(senderId) || new Set();
        senderSockets.forEach((socketId) => {
          io.to(socketId).emit("message-status-update", {
            senderId,
            receiverId: userId,
            status: "read",
          });
        });

        const receiverSocket = userSocketMap.get(userId) || new Set();
        receiverSocket.forEach((socketId) => {
          io.to(socketId).emit("message-status-update", {
            senderId,
            receiverId: userId,
            status: "read",
          });
        });
      }
    } catch (error) {
      console.error("Error updating message status to read:", error);
    }
  };

  const emitToUser = (userId, event, payload) => {
    const sockets = userSocketMap.get(userId);
    if (sockets && sockets.size > 0) {
      console.log(
        `[⬆️ SENDING] '${event}' to User ${userId} (Socket IDs: ${Array.from(sockets).join(", ")})`,
      );
      sockets.forEach((socketId) => {
        io.to(socketId).emit(event, payload);
      });
    } else {
      console.warn(
        `[⚠️ FAILED SEND] '${event}' to User ${userId} - User is OFFLINE or ID mismatch`,
      );
    }
  };

  const emitTypingEvent = async ({ event, chatType, receiverId, channelId, senderId }) => {
    try {
      const sender = await User.findById(senderId, "firstName lastName");
      const payload = {
        chatType,
        senderId,
        sender: sender
          ? {
              _id: sender._id,
              firstName: sender.firstName,
              lastName: sender.lastName,
            }
          : { _id: senderId },
        receiverId: receiverId || null,
        channelId: channelId || null,
      };

      if (chatType === "contact" && receiverId) {
        emitToUser(receiverId, event, payload);
        return;
      }

      if (chatType === "channel" && channelId) {
        const channel = await Channel.findById(channelId).populate("members");
        if (!channel) return;

        const memberIds = new Set(
          (channel.members || []).map((member) => member._id.toString()),
        );
        if (channel.admin) {
          memberIds.add(channel.admin.toString());
        }
        memberIds.delete(senderId);

        memberIds.forEach((memberId) => {
          emitToUser(memberId, event, payload);
        });
      }
    } catch (error) {
      console.error("Error emitting typing event:", error);
    }
  };

  io.on("connection", async (socket) => {
    const userId = socket.handshake.query.userId;

    if (userId) {
      addUserSocket(userId, socket.id);
      io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      console.log(`User Connected: ${userId} with socket ID: ${socket.id}`);

      // Handle undelivered messages
      const undeliveredMessages = await Message.find({
        receiver: userId,
        status: "sent",
      });

      if (undeliveredMessages.length > 0) {
        await Message.updateMany(
          { receiver: userId, status: "sent" },
          { $set: { status: "delivered" } },
        );

        const senderIds = [
          ...new Set(undeliveredMessages.map((msg) => msg.sender.toString())),
        ];

        senderIds.forEach((senderId) => {
          const senderSockets = userSocketMap.get(senderId) || new Set();
          senderSockets.forEach((sockId) =>
            io.to(sockId).emit("message-status-update", {
              receiverId: userId,
              status: "delivered",
            }),
          );
        });
      }
    } else {
      console.log("User ID not present.");
    }

    socket.on("confirm-read", updateMessageStatusToRead);

    socket.on("send-channel-message", (message) =>
      sendChannelMessage(message, socket),
    );

    socket.on("sendMessage", (message) => sendMessage(message, socket));

    socket.on("disconnect", () => {
      removeUserSocket(userId, socket.id);
      io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      console.log(`Client Disconnected: ${socket.id}`);
    });

    // Initiate Call 
    socket.on("call:initiate", async ({ receiverId, callType }) => {
      try {
        const caller = await User.findById(
          userId,
          "firstName lastName image email",
        );
        if (!caller) return;

        // Create initial call record
        const call = await Call.create({
          callId: crypto.randomUUID(),
          callerId: userId,
          receiverId,
          callType,
          status: "ongoing",
          startedAt: new Date(),
        });

        const payload = {
          callId: call._id,
          callerId: userId,
          callType,
          callerName:
            `${caller.firstName || "Unknown"} ${caller.lastName || ""}`.trim(),
          callerImage: caller.image || "",
          callerEmail: caller.email,
        };

        // Notify Receiver
        emitToUser(receiverId, "incoming-call", payload);
      } catch (err) {
        console.error("Call initiate error:", err);
      }
    });

    // 2. Accept Call
    socket.on("call:accept", async ({ callId, callerId }) => {
      const call = await Call.findByIdAndUpdate(
        callId,
        { connectedAt: new Date() },
        { new: true },
      );
      emitToUser(callerId || call?.callerId.toString(), "call-accepted", {
        callId,
      });
    });

    // Reject Call
    socket.on("call:reject", async ({ callId, callerId }) => {
      const call = await Call.findByIdAndUpdate(
        callId,
        { status: "rejected", endedAt: new Date() },
        { new: true },
      );
      emitToUser(callerId || call?.callerId.toString(), "call-rejected", {
        callId,
      });
    });

    // End Call (Hangup)
    socket.on("call:end", async ({ to, callId }) => {
      // Notify the other user immediately to stop their streams
      if (to) {
        emitToUser(to, "call:end", { from: userId });
      }

      // Clean up Database
      if (callId) {
        const call = await Call.findById(callId);
        if (call) {
          call.endedAt = new Date();
          call.status = "completed";
          await call.save();

          const duration = call.connectedAt
            ? Math.floor((call.endedAt - call.connectedAt) / 1000)
            : 0;

          // Log as a chat message
          await Message.create({
            sender: call.callerId,
            receiver: call.receiverId,
            messageType: "call",
            callId: call._id,
            callMeta: {
              callType: call.callType,
              status: "completed",
              duration,
            },
          });
        }
      }
    });


    // Offer (Handling "Polite" vs "Impolite")
    // Note: We use 'description' now instead of just 'offer' to be generic
    socket.on("call:offer", ({ to, description }) => {
      emitToUser(to, "call:offer", {
        description,
        from: userId, 
      });
    });

    // Answer
    socket.on("call:answer", ({ to, description }) => {
      emitToUser(to, "call:answer", {
        description,
        from: userId,
      });
    });

    // ICE Candidates
    socket.on("call:ice-candidate", ({ to, candidate }) => {
      emitToUser(to, "call:ice-candidate", {
        candidate,
        from: userId,
      });
    });

    socket.on("typing", ({ chatType, receiverId, channelId }) => {
      emitTypingEvent({
        event: "typing",
        chatType,
        receiverId,
        channelId,
        senderId: userId,
      });
    });

    socket.on("stop-typing", ({ chatType, receiverId, channelId }) => {
      emitTypingEvent({
        event: "stop-typing",
        chatType,
        receiverId,
        channelId,
        senderId: userId,
      });
    });
    
  });
};

export { io, setupSocket, userSocketMap };
