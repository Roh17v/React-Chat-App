import { Server as SocketIoServer } from "socket.io";
import Message from "./models/message.model.js";
import { Channel } from "./models/channel.model.js";
import { User } from "./models/user.model.js";
import Call from "./models/call.model.js";
import { sendPushToTokens } from "./utils/pushNotifications.js";
import mongoose from "mongoose";

let io;
let userSocketMap;

const buildCallQuery = (callId) => {
  if (!callId) return null;
  const isObjectId = mongoose.Types.ObjectId.isValid(callId);
  if (isObjectId) {
    return { $or: [{ _id: callId }, { callId }] };
  }
  return { callId };
};

const setupSocket = (server) => {
  io = new SocketIoServer(server, {
    cors: {
      origin: [
        process.env.FRONTEND_URL,
        "http://localhost:5173",
        "http://localhost",
        "https://localhost",
        "capacitor://localhost",
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
    if (!userSocketMap.has(userId)) return false;
    const sockets = userSocketMap.get(userId);
    sockets.delete(socketId);
    if (sockets.size === 0) {
      userSocketMap.delete(userId);
      return true;
    }
    return false;
  };

  const sendMessage = async (message, socket) => {
    const { clientTempId, ...messageFields } = message;
    try {
      const receiverSockets = userSocketMap.get(messageFields.receiver) || new Set();
      const senderSockets = userSocketMap.get(messageFields.sender) || new Set();

      // Determine delivery status instantly
      const isReceiverOnline = receiverSockets.size > 0;
      const deliveryStatus = isReceiverOnline ? "delivered" : "sent";

      // Build an in-memory message object with a pre-generated ID
      const messageId = new mongoose.Types.ObjectId();
      const now = new Date();

      // Emit to receiver immediately
      const instantPayload = {
        _id: messageId,
        sender: messageFields.sender,
        receiver: messageFields.receiver,
        content: messageFields.content,
        messageType: messageFields.messageType,
        fileUrl: messageFields.fileUrl || null,
        replyTo: messageFields.replyTo || null,
        status: deliveryStatus,
        createdAt: now,
        updatedAt: now,
      };

      // Emit to receiver immediately
      receiverSockets.forEach((socketId) =>
        io.to(socketId).emit("receiveMessage", instantPayload),
      );

      // Emit confirmation to sender with the clientTempId so the frontend
      // can swap the optimistic placeholder for the real confirmed message.
      senderSockets.forEach((socketId) =>
        io.to(socketId).emit("receiveMessage", {
          ...instantPayload,
          clientTempId: clientTempId || null,
        }),
      );

      // Persist to DB asynchronously (non-blocking)
      (async () => {
        // Save to DB 
        let createdMessage;
        try {
          createdMessage = await Message.create({
            _id: messageId,
            ...messageFields,
            status: deliveryStatus,
            createdAt: now,
            updatedAt: now,
          });
        } catch (createError) {
          console.error("Error saving message to DB:", createError);
          // Only emit failed if the message was never saved.
          senderSockets.forEach((socketId) =>
            io.to(socketId).emit("messageSendFailed", {
              clientTempId: clientTempId || null,
              error: "Message could not be saved. Please retry.",
            }),
          );
          return;
        }

        // Post-save operations
        try {
          const messageData = await Message.findById(createdMessage._id)
            .populate("sender", "id email firstName lastName image color lastSeen")
            .populate("receiver", "id email firstName lastName image color lastSeen");

          // Update contacts lists for new DM pairs.
          const receiver = await User.findById(messageFields.receiver);
          if (receiver && !receiver.contacts.includes(messageFields.sender)) {
            await User.findByIdAndUpdate(messageFields.receiver, {
              $addToSet: { contacts: messageFields.sender },
            });
            receiverSockets.forEach((socketId) =>
              io.to(socketId).emit("new-dm-contact", messageData.sender),
            );
          }

          const sender = await User.findById(messageFields.sender);
          if (sender && !sender.contacts.includes(messageFields.receiver)) {
            await User.findByIdAndUpdate(messageFields.sender, {
              $addToSet: { contacts: messageFields.receiver },
            });
            senderSockets.forEach((socketId) =>
              io.to(socketId).emit("new-dm-contact", messageData.receiver),
            );
          }

          // Push notification for offline receivers.
          if (!isReceiverOnline) {
            const receiverUser = await User.findById(messageFields.receiver).select("pushTokens");
            const pushTokens = receiverUser?.pushTokens || [];
            void sendPushToTokens({
              tokens: pushTokens,
              title: `${messageData.sender.firstName || "New"} message`,
              body: messageData.content || "Sent you a message.",
              imageUrl: messageData.sender.image || undefined,
              data: {
                type: "message",
                chatType: "contact",
                chatId: messageData.sender._id.toString(),
                senderId: messageData.sender._id.toString(),
                senderName: `${messageData.sender.firstName || ""} ${messageData.sender.lastName || ""}`.trim(),
                senderImage: messageData.sender.image || "",
                url: `/chats?type=message&chatType=contact&chatId=${messageData.sender._id.toString()}`,
              },
            });
          }
        } catch (postSaveError) {
          console.error("Post-save operations failed (message was saved):", postSaveError);
        }
      })();
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
        const offlineMemberIds = [];
        channel.members.forEach((contact) => {
          const memberSocketId =
            userSocketMap.get(contact._id.toString()) || new Set();
          if (memberSocketId.size > 0) {
            memberSocketId.forEach((socketId) => {
              io.to(socketId).emit("receive-channel-message", finalData);
            });
          } else {
            offlineMemberIds.push(contact._id.toString());
          }
        });
        const adminSocketId =
          userSocketMap.get(channel.admin.toString()) || new Set();
        if (adminSocketId.size > 0) {
          adminSocketId.forEach((socketId) => {
            io.to(socketId).emit("receive-channel-message", finalData);
          });
        } else if (channel.admin?.toString() !== sender) {
          offlineMemberIds.push(channel.admin.toString());
        }

        const uniqueOfflineIds = Array.from(
          new Set(offlineMemberIds.filter((id) => id !== sender)),
        );
        if (uniqueOfflineIds.length > 0) {
          const users = await User.find({ _id: { $in: uniqueOfflineIds } })
            .select("pushTokens")
            .lean();
          const pushTokens = users.flatMap((user) => user.pushTokens || []);
          void sendPushToTokens({
            tokens: pushTokens,
            title: `${messageData.sender.firstName || "New"} in ${
              channel.name || "channel"
            }`,
            body: messageData.content || "Sent a file.",
            imageUrl: messageData.sender.image || undefined,
            data: {
              type: "channel-message",
              chatType: "channel",
              chatId: channel._id.toString(),
              channelId: channel._id.toString(),
              channelName: channel.name || "channel",
              senderId: messageData.sender._id.toString(),
              senderName: `${messageData.sender.firstName || ""} ${
                messageData.sender.lastName || ""
              }`.trim(),
              senderImage: messageData.sender.image || "",
              url: `/chats?type=channel-message&chatType=channel&chatId=${channel._id.toString()}`,
            },
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

  // Track who is currently typing so we can emit stop-typing on disconnect.
  // Map<userId, { chatType, receiverId, channelId }>
  const activeTypingMap = new Map();

  const emitTypingEvent = async ({
    event,
    chatType,
    receiverId,
    channelId,
    senderId,
  }) => {
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

    socket.on("disconnect", async () => {
      // If this user was actively typing when they disconnected, clear the
      // indicator on the recipient's side immediately.
      const typingState = activeTypingMap.get(userId);
      if (typingState) {
        activeTypingMap.delete(userId);
        // Fire-and-forget — don't block the disconnect handler.
        emitTypingEvent({ event: "stop-typing", senderId: userId, ...typingState });
      }

      const becameOffline = removeUserSocket(userId, socket.id);
      if (becameOffline && userId) {
        try {
          const lastSeen = new Date();
          await User.findByIdAndUpdate(userId, { $set: { lastSeen } });
          io.emit("user-last-seen", { userId, lastSeen });
        } catch (error) {
          console.error("Error updating last seen:", error);
        }
      }
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
        const receiverSockets = userSocketMap.get(receiverId) || new Set();
        if (receiverSockets.size === 0) {
          const receiverUser =
            await User.findById(receiverId).select("pushTokens");
          const pushTokens = receiverUser?.pushTokens || [];
          void sendPushToTokens({
            tokens: pushTokens,
            title: "Incoming call",
            body: `${payload.callerName} is calling you.`,
            imageUrl: payload.callerImage || undefined,
            data: {
              type: "call",
              callId: payload.callId.toString(),
              callerId: payload.callerId.toString(),
              callType,
              callerName: payload.callerName || "Unknown",
              callerImage: payload.callerImage || "",
              callerEmail: payload.callerEmail || "",
              url: `/chats?type=call&callId=${payload.callId.toString()}&callerId=${payload.callerId.toString()}&callType=${callType}`,
            },
          });
        }
      } catch (err) {
        console.error("Call initiate error:", err);
      }
    });

    // 2. Accept Call
    socket.on("call:accept", async ({ callId, callerId }) => {
      try {
        const query = buildCallQuery(callId);
        const call = query ? await Call.findOne(query) : null;

        // Keep a single shared connected timestamp for all participants.
        if (call && !call.connectedAt) {
          call.connectedAt = new Date();
          await call.save();
        }

        const connectedAtMs = call?.connectedAt
          ? new Date(call.connectedAt).getTime()
          : Date.now();
        const serverNowMs = Date.now();
        const resolvedCallId = call?._id?.toString() || callId;
        const targetCallerId = callerId || call?.callerId?.toString();
        const receiverId = call?.receiverId?.toString() || userId;

        if (targetCallerId) {
          emitToUser(targetCallerId, "call-accepted", {
            callId: resolvedCallId,
            connectedAt: connectedAtMs,
            serverNow: serverNowMs,
          });
          emitToUser(targetCallerId, "call-connected", {
            callId: resolvedCallId,
            connectedAt: connectedAtMs,
            serverNow: serverNowMs,
          });
        }

        if (receiverId) {
          emitToUser(receiverId, "call-connected", {
            callId: resolvedCallId,
            connectedAt: connectedAtMs,
            serverNow: serverNowMs,
          });
        }
      } catch (error) {
        console.error("Call accept error:", error);
      }
    });

    // Reject Call
    socket.on("call:reject", async ({ callId, callerId }) => {
      const query = buildCallQuery(callId);
      const call = query
        ? await Call.findOneAndUpdate(
            query,
            { status: "rejected", endedAt: new Date() },
            { new: true },
          )
        : null;
      const targetCallerId = callerId || call?.callerId?.toString();
      if (targetCallerId) {
        emitToUser(targetCallerId, "call-rejected", { callId });
      }
    });

    // End Call (Hangup)
    socket.on("call:end", async ({ to, callId }) => {
      // Notify the other user immediately on both event names:
      //   "call:end"    → IncomingCallOverlay (web) + NativeCallHandler (native signaling)
      // NOTE: We deliberately do NOT emit "call-ended" here. Emitting call-ended causes
      // SocketContext to call clearActiveCall() on the recipient, which unmounts VideoCallScreen
      // mid-call and stops the local camera tracks. The call:end event is sufficient:
      //   - IncomingCallOverlay listens to call:end directly
      //   - NativeCallHandler listens to call:end directly
      //   - SocketContext's call:end handler now always clears incomingCall
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

    socket.on("call:ice-candidates", ({ to, candidates }) => {
      if (!Array.isArray(candidates) || candidates.length === 0) return;
      emitToUser(to, "call:ice-candidates", {
        candidates,
        from: userId,
      });
    });

    socket.on("typing", ({ chatType, receiverId, channelId }) => {
      // Track this user as actively typing.
      activeTypingMap.set(userId, { chatType, receiverId, channelId });
      emitTypingEvent({
        event: "typing",
        chatType,
        receiverId,
        channelId,
        senderId: userId,
      });
    });

    socket.on("stop-typing", ({ chatType, receiverId, channelId }) => {
      // Clear tracking when stop-typing is received.
      activeTypingMap.delete(userId);
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
