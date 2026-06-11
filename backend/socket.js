import { Server as SocketIoServer } from "socket.io";
import Message from "./models/message.model.js";
import { Channel } from "./models/channel.model.js";
import { User } from "./models/user.model.js";
import { Connection } from "./models/connection.model.js";
import Call from "./models/call.model.js";
import { sendPushToTokens } from "./utils/pushNotifications.js";
import mongoose from "mongoose";
import { finalizeCallRecord } from "./services/callFinalize.service.js";

let io;
let userSocketMap;
const callPairLocks = new Map();
const userCallLocks = new Map();
const RINGING_CALL_REUSE_WINDOW_MS = 90_000;
const CONNECTED_CALL_BUSY_WINDOW_MS = 6 * 60 * 60 * 1000;
const RINGING_CALL_AUTO_END_MS = 45_000;
const CALL_PEER_DISCONNECT_GRACE_MS = 12_000;
const CALL_PEER_HEARTBEAT_STALE_MS = 30_000;

export const addContactToActiveSockets = (userId, contactId) => {
  const sockets = userSocketMap?.get(userId);
  if (sockets) {
    sockets.forEach(socketId => {
      const socketObj = io.sockets.sockets.get(socketId);
      if (socketObj) {
        if (!socketObj.contacts) socketObj.contacts = new Set();
        socketObj.contacts.add(contactId);
        console.log(`Added contact ${contactId} to active socket ${socketId} for user ${userId}`);
      }
    });
  }
};

const activeCallByUser = new Map();
const activeCallById = new Map();
const ringingCallTimeoutById = new Map();
const callMediaStateByCallId = new Map();

const buildCallQuery = (callId) => {
  if (!callId) return null;
  const isObjectId = mongoose.Types.ObjectId.isValid(callId);
  if (isObjectId) {
    return { $or: [{ _id: callId }, { callId }] };
  }
  return { callId };
};

const normalizeId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return value._id.toString();
  return value.toString();
};

const getCallPairKey = (a, b) => {
  const first = normalizeId(a);
  const second = normalizeId(b);
  return [first, second].sort().join(":");
};

const withCallPairLock = async (pairKey, work) => {
  const previous = callPairLocks.get(pairKey) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });

  callPairLocks.set(pairKey, current);
  await previous;

  try {
    return await work();
  } finally {
    releaseCurrent();
    if (callPairLocks.get(pairKey) === current) {
      callPairLocks.delete(pairKey);
    }
  }
};

const withUsersCallLock = async (userIds, work) => {
  const normalizedUserIds = Array.from(
    new Set(userIds.map(normalizeId).filter(Boolean)),
  ).sort();
  const acquiredLocks = [];

  try {
    for (const id of normalizedUserIds) {
      const previous = userCallLocks.get(id) || Promise.resolve();
      let releaseCurrent;
      const current = new Promise((resolve) => {
        releaseCurrent = resolve;
      });

      userCallLocks.set(id, current);
      await previous;
      acquiredLocks.push({ id, current, releaseCurrent });
    }

    return await work();
  } finally {
    for (let i = acquiredLocks.length - 1; i >= 0; i -= 1) {
      const { id, current, releaseCurrent } = acquiredLocks[i];
      releaseCurrent();
      if (userCallLocks.get(id) === current) {
        userCallLocks.delete(id);
      }
    }
  }
};

const upsertActiveCall = (callId, callerId, receiverId, phase = "ringing") => {
  const normalizedCallId = normalizeId(callId);
  const normalizedCallerId = normalizeId(callerId);
  const normalizedReceiverId = normalizeId(receiverId);
  if (!normalizedCallId || !normalizedCallerId || !normalizedReceiverId) return;
  const now = Date.now();
  const previous = activeCallById.get(normalizedCallId) || {};
  const lastHeartbeatByUser = {
    ...(previous.lastHeartbeatByUser || {}),
    [normalizedCallerId]: now,
    [normalizedReceiverId]: now,
  };
  const disconnectedAtByUser = { ...(previous.disconnectedAtByUser || {}) };
  const callerSockets = userSocketMap?.get(normalizedCallerId);
  const receiverSockets = userSocketMap?.get(normalizedReceiverId);
  if ((callerSockets?.size || 0) > 0) {
    delete disconnectedAtByUser[normalizedCallerId];
  }
  if ((receiverSockets?.size || 0) > 0) {
    delete disconnectedAtByUser[normalizedReceiverId];
  }

  activeCallById.set(normalizedCallId, {
    callerId: normalizedCallerId,
    receiverId: normalizedReceiverId,
    phase: phase === "connected" ? "connected" : "ringing",
    updatedAtMs: now,
    lastHeartbeatByUser,
    disconnectedAtByUser,
  });
  activeCallByUser.set(normalizedCallerId, normalizedCallId);
  activeCallByUser.set(normalizedReceiverId, normalizedCallId);
};

const markUserReconnectedInActiveSessions = (userId) => {
  const normalizedUserId = normalizeId(userId);
  if (!normalizedUserId) return;
  const now = Date.now();

  activeCallById.forEach((session, callId) => {
    if (!session) return;
    if (
      session.callerId !== normalizedUserId &&
      session.receiverId !== normalizedUserId
    ) {
      return;
    }

    const updatedSession = {
      ...session,
      updatedAtMs: now,
      lastHeartbeatByUser: {
        ...(session.lastHeartbeatByUser || {}),
        [normalizedUserId]: now,
      },
      disconnectedAtByUser: {
        ...(session.disconnectedAtByUser || {}),
      },
    };
    delete updatedSession.disconnectedAtByUser[normalizedUserId];
    activeCallById.set(callId, updatedSession);
  });
};

const normalizeCallMediaState = ({
  videoOff = false,
  videoSource,
  screenShareActive = false,
} = {}) => {
  const normalizedVideoOff = Boolean(videoOff);
  const normalizedVideoSource =
    typeof videoSource === "string" ? videoSource.toLowerCase() : "";

  let resolvedVideoSource = "camera";
  if (normalizedVideoOff || normalizedVideoSource === "off") {
    resolvedVideoSource = "off";
  } else if (
    normalizedVideoSource === "screen" ||
    Boolean(screenShareActive)
  ) {
    resolvedVideoSource = "screen";
  }

  return {
    videoOff: resolvedVideoSource === "off",
    videoSource: resolvedVideoSource,
    screenShareActive: resolvedVideoSource === "screen",
  };
};

const upsertCallMediaState = (
  callId,
  userId,
  { videoOff, videoSource, screenShareActive, mediaSeq } = {},
) => {
  const normalizedCallId = normalizeId(callId);
  const normalizedUserId = normalizeId(userId);
  if (!normalizedCallId || !normalizedUserId) return;

  const current = callMediaStateByCallId.get(normalizedCallId) || {};
  const previous = current[normalizedUserId];
  const parsedSeq = Number(mediaSeq);
  const normalizedMediaState = normalizeCallMediaState({
    videoOff,
    videoSource,
    screenShareActive,
  });

  if (
    Number.isFinite(parsedSeq) &&
    previous &&
    Number.isFinite(Number(previous.mediaSeq)) &&
    parsedSeq <= Number(previous.mediaSeq)
  ) {
    return;
  }

  current[normalizedUserId] = {
    ...normalizedMediaState,
    ...(Number.isFinite(parsedSeq) ? { mediaSeq: parsedSeq } : {}),
    updatedAtMs: Date.now(),
  };
  callMediaStateByCallId.set(normalizedCallId, current);
};

const getCallMediaState = (callId, userId) => {
  const normalizedCallId = normalizeId(callId);
  const normalizedUserId = normalizeId(userId);
  if (!normalizedCallId || !normalizedUserId) return null;
  const current = callMediaStateByCallId.get(normalizedCallId);
  if (!current) return null;
  return current[normalizedUserId] || null;
};

const clearCallMediaState = (callId) => {
  const normalizedCallId = normalizeId(callId);
  if (!normalizedCallId) return;
  callMediaStateByCallId.delete(normalizedCallId);
};

const clearActiveCallById = (callId) => {
  const normalizedCallId = normalizeId(callId);
  if (!normalizedCallId) return;
  clearCallMediaState(normalizedCallId);
  const timeoutHandle = ringingCallTimeoutById.get(normalizedCallId);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    ringingCallTimeoutById.delete(normalizedCallId);
  }
  const entry = activeCallById.get(normalizedCallId);
  if (!entry) return;

  if (activeCallByUser.get(entry.callerId) === normalizedCallId) {
    activeCallByUser.delete(entry.callerId);
  }
  if (activeCallByUser.get(entry.receiverId) === normalizedCallId) {
    activeCallByUser.delete(entry.receiverId);
  }
  activeCallById.delete(normalizedCallId);
};

const clearActiveCallForPair = (firstUserId, secondUserId) => {
  const normalizedFirst = normalizeId(firstUserId);
  const normalizedSecond = normalizeId(secondUserId);
  if (!normalizedFirst || !normalizedSecond) return;

  const firstCallId = activeCallByUser.get(normalizedFirst);
  const secondCallId = activeCallByUser.get(normalizedSecond);
  if (firstCallId && firstCallId === secondCallId) {
    clearActiveCallById(firstCallId);
  }
};

const isConnectedSessionLikelyAlive = (session, perspectiveUserId = "") => {
  if (!session) return false;
  if (session.phase !== "connected") return true;

  const callerId = normalizeId(session.callerId);
  const receiverId = normalizeId(session.receiverId);
  if (!callerId || !receiverId) return true;

  const normalizedPerspective = normalizeId(perspectiveUserId);
  const peerId = normalizedPerspective
    ? callerId === normalizedPerspective
      ? receiverId
      : receiverId === normalizedPerspective
        ? callerId
        : ""
    : "";
  const targetPeerId = peerId || receiverId;

  const peerSockets = userSocketMap?.get(targetPeerId);
  const peerOnline = (peerSockets?.size || 0) > 0;
  if (peerOnline) return true;

  const now = Date.now();
  const peerDisconnectedAt = Number(
    session.disconnectedAtByUser?.[targetPeerId] || 0,
  );
  const peerLastHeartbeatAt = Number(
    session.lastHeartbeatByUser?.[targetPeerId] || 0,
  );
  const peerDisconnectedTooLong =
    peerDisconnectedAt > 0 &&
    now - peerDisconnectedAt > CALL_PEER_DISCONNECT_GRACE_MS;
  const peerHeartbeatStale =
    !peerLastHeartbeatAt ||
    now - peerLastHeartbeatAt > CALL_PEER_HEARTBEAT_STALE_MS;

  if (peerDisconnectedTooLong && peerHeartbeatStale) {
    return false;
  }
  return true;
};

const isUserBusyInActiveCall = (...userIds) => {
  const normalizedUserIds = userIds.map(normalizeId).filter(Boolean);
  if (normalizedUserIds.length === 0) return false;
  const now = Date.now();

  for (const userId of normalizedUserIds) {
    const activeCallId = activeCallByUser.get(userId);
    if (!activeCallId) continue;

    const session = activeCallById.get(activeCallId);
    if (!session) {
      activeCallByUser.delete(userId);
      continue;
    }

    const isStaleRinging =
      session.phase === "ringing" &&
      now - (session.updatedAtMs || 0) > RINGING_CALL_REUSE_WINDOW_MS;
    if (isStaleRinging) {
      clearActiveCallById(activeCallId);
      continue;
    }

    if (!isConnectedSessionLikelyAlive(session, userId)) {
      clearActiveCallById(activeCallId);
      continue;
    }

    return true;
  }

  return false;
};

const reconcileBusyUsersWithDb = async (...userIds) => {
  const normalizedUserIds = Array.from(
    new Set(userIds.map(normalizeId).filter(Boolean)),
  );
  if (normalizedUserIds.length === 0) return;

  const activeCallIds = Array.from(
    new Set(
      normalizedUserIds
        .map((id) => activeCallByUser.get(id))
        .filter(Boolean),
    ),
  );
  if (activeCallIds.length === 0) return;

  await Promise.all(
    activeCallIds.map(async (activeCallId) => {
      const normalizedCallId = normalizeId(activeCallId);
      if (!normalizedCallId) return;

      const session = activeCallById.get(normalizedCallId);
      if (!session) {
        clearActiveCallById(normalizedCallId);
        return;
      }

      const query = buildCallQuery(normalizedCallId);
      const dbCall = query
        ? await Call.findOne(query)
            .select("status endedAt connectedAt startedAt")
            .lean()
        : null;

      if (!isCallRecordPotentiallyActive(dbCall)) {
        clearActiveCallById(normalizedCallId);
        return;
      }

      session.phase = dbCall.connectedAt ? "connected" : "ringing";
      session.updatedAtMs = Date.now();
      activeCallById.set(normalizedCallId, session);
    }),
  );
};

const isCallRecordPotentiallyActive = (call, nowMs = Date.now()) => {
  if (!call) return false;
  if (call.endedAt) return false;
  if (call.status !== "ongoing") return false;

  const connectedAtMs = call.connectedAt
    ? new Date(call.connectedAt).getTime()
    : 0;
  if (connectedAtMs > 0) {
    return nowMs - connectedAtMs <= CONNECTED_CALL_BUSY_WINDOW_MS;
  }

  const startedAtMs = call.startedAt ? new Date(call.startedAt).getTime() : 0;
  if (startedAtMs > 0) {
    return nowMs - startedAtMs <= RINGING_CALL_REUSE_WINDOW_MS;
  }

  return false;
};

const findBlockingCallInDb = async (firstUserId, secondUserId) => {
  const normalizedFirst = normalizeId(firstUserId);
  const normalizedSecond = normalizeId(secondUserId);
  if (!normalizedFirst || !normalizedSecond) return null;

  const nowMs = Date.now();
  const candidates = await Call.find({
    status: "ongoing",
    endedAt: null,
    $or: [
      { callerId: { $in: [normalizedFirst, normalizedSecond] } },
      { receiverId: { $in: [normalizedFirst, normalizedSecond] } },
    ],
  })
    .sort({ connectedAt: -1, startedAt: -1 })
    .select("_id callerId receiverId callType connectedAt startedAt status endedAt")
    .lean();

  for (const candidate of candidates) {
    if (!isCallRecordPotentiallyActive(candidate, nowMs)) continue;

    const caller = normalizeId(candidate.callerId);
    const receiver = normalizeId(candidate.receiverId);
    if (!caller || !receiver) continue;

    const isSamePair =
      (caller === normalizedFirst && receiver === normalizedSecond) ||
      (caller === normalizedSecond && receiver === normalizedFirst);

    // Same-pair fresh ringing calls are handled by the explicit reuse query.
    if (isSamePair && !candidate.connectedAt) continue;

    return candidate;
  }

  return null;
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
    // Android/WebView can temporarily throttle JS timers while a native call
    // Activity is foregrounded. Increase ping timeout and enable state
    // recovery so short transport interruptions don't break in-call signaling.
    pingInterval: 25_000,
    pingTimeout: 120_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
      skipMiddlewares: true,
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

      // Enforce connection rule using in-memory cache!
      let isConnected = socket.contacts && socket.contacts.has(messageFields.receiver);

      if (!isConnected) {
        // FALLBACK FOR OLD USERS/CONTACTS:
        // Check if they are in each other's contacts array in DB 
        // OR if they have any existing message history.
        const user = await User.findById(messageFields.sender).select("contacts");
        const inDbContacts = user?.contacts?.some(c => c.toString() === messageFields.receiver);
        
        if (inDbContacts) {
          isConnected = true;
          if (socket.contacts) socket.contacts.add(messageFields.receiver);
        } else {
          // Check if there is ANY existing message history between them
          const existingHistory = await Message.findOne({
            $or: [
              { sender: messageFields.sender, receiver: messageFields.receiver },
              { sender: messageFields.receiver, receiver: messageFields.sender }
            ]
          }).lean();
          
          if (existingHistory) {
            isConnected = true;
            // Auto-add to contacts so next time it's fast!
            await User.findByIdAndUpdate(messageFields.sender, { $addToSet: { contacts: messageFields.receiver } });
            await User.findByIdAndUpdate(messageFields.receiver, { $addToSet: { contacts: messageFields.sender } });
            if (socket.contacts) socket.contacts.add(messageFields.receiver);
            console.log(`[Transition] Auto-added contact ${messageFields.receiver} for user ${messageFields.sender} due to existing history.`);
          }
        }
      }

      if (!isConnected) {
        console.log(`Blocked unauthorized message from ${messageFields.sender} to ${messageFields.receiver}`);
        socket.emit("errorMessage", "You must be connected to message this user.");
        return;
      }

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
        fileName: messageFields.fileName || null,
        fileMetadata: messageFields.fileMetadata || {},
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
      const { channelId, messageType, content, sender, fileUrl, fileName, fileMetadata } = message;

      const newMessage = await Message.create({
        sender,
        content,
        messageType,
        receiver: null,
        fileUrl,
        channelId,
        fileName,
        fileMetadata: fileMetadata || {},
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
          const contactIdStr = contact._id.toString();
          const memberSocketId =
            userSocketMap.get(contactIdStr) || new Set();
          if (memberSocketId.size > 0) {
            memberSocketId.forEach((socketId) => {
              const payload = contactIdStr === sender 
                ? { ...finalData, clientTempId: message.clientTempId || null }
                : finalData;
              io.to(socketId).emit("receive-channel-message", payload);
            });
          } else {
            offlineMemberIds.push(contactIdStr);
          }
        });
        
        const adminIdStr = channel.admin?.toString();
        const adminSocketId =
          adminIdStr ? (userSocketMap.get(adminIdStr) || new Set()) : new Set();
        if (adminSocketId.size > 0) {
          adminSocketId.forEach((socketId) => {
            const payload = adminIdStr === sender 
              ? { ...finalData, clientTempId: message.clientTempId || null }
              : finalData;
            io.to(socketId).emit("receive-channel-message", payload);
          });
        } else if (adminIdStr && adminIdStr !== sender) {
          offlineMemberIds.push(adminIdStr);
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
      // Flip every unread message from `sender` to `receiver` to `read`.
      // Previously we only matched `status: 'delivered'`, which left
      // messages stuck at `sent` forever when the recipient was offline
      // at the time of original delivery (the `delivered` bump never
      // happened). The result on the sender's UI was a partial flip:
      // only the messages that briefly hit `delivered` ever turned blue.
      const updatedMessages = await Message.updateMany(
        {
          receiver: userId,
          sender: senderId,
          status: { $in: ["sent", "delivered"] },
        },
        { $set: { status: "read", updatedAt: new Date() } },
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

  // Some call teardown races happen when the callee screen is transitioning
  // and the first socket event lands before listeners are fully attached.
  // Retry a couple of short times for critical teardown events.
  const emitToUserReliable = (
    userId,
    event,
    payload,
    retryDelaysMs = [0, 250, 900],
  ) => {
    const normalizedUserId = normalizeId(userId);
    if (!normalizedUserId) return;
    retryDelaysMs.forEach((delayMs) => {
      if (delayMs <= 0) {
        emitToUser(normalizedUserId, event, payload);
        return;
      }
      setTimeout(() => {
        emitToUser(normalizedUserId, event, payload);
      }, delayMs);
    });
  };

  const clearRingingTimeout = (callId) => {
    const normalizedCallId = normalizeId(callId);
    if (!normalizedCallId) return;
    const timeoutHandle = ringingCallTimeoutById.get(normalizedCallId);
    if (!timeoutHandle) return;
    clearTimeout(timeoutHandle);
    ringingCallTimeoutById.delete(normalizedCallId);
  };

  const scheduleRingingTimeout = (callId) => {
    const normalizedCallId = normalizeId(callId);
    if (!normalizedCallId) return;

    clearRingingTimeout(normalizedCallId);
    const timeoutHandle = setTimeout(async () => {
      ringingCallTimeoutById.delete(normalizedCallId);

      try {
        const query = buildCallQuery(normalizedCallId);
        const call = query ? await Call.findOne(query) : null;
        if (!call) return;
        if (call.endedAt || call.status !== "ongoing" || call.connectedAt) return;

        call.status = "missed";
        call.endedAt = new Date();
        await call.save();

        const callerId = normalizeId(call.callerId);
        const receiverId = normalizeId(call.receiverId);

        clearActiveCallById(normalizedCallId);

        if (callerId) {
          emitToUser(callerId, "call-rejected", {
            callId: normalizedCallId,
            reason: "no_answer",
          });
        }
        if (receiverId) {
          emitToUser(receiverId, "call:end", {
            from: callerId,
            callId: normalizedCallId,
          });
        }
      } catch (error) {
        console.error("Failed auto-ending stale ringing call:", error);
      }
    }, RINGING_CALL_AUTO_END_MS);

    ringingCallTimeoutById.set(normalizedCallId, timeoutHandle);
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
      markUserReconnectedInActiveSessions(userId);
      io.emit("onlineUsers", Array.from(userSocketMap.keys()));
      console.log(`User Connected: ${userId} with socket ID: ${socket.id}`);

      // Fetch contacts for in-memory check
      try {
        const user = await User.findById(userId).select("contacts");
        const contacts = user?.contacts?.map(c => c.toString()) || [];
        socket.contacts = new Set(contacts);
        console.log(`Loaded ${contacts.length} contacts for User ${userId} in memory.`);
      } catch (err) {
        console.error(`Error loading contacts for User ${userId}:`, err);
        socket.contacts = new Set();
      }

      // Handle undelivered messages
      const undeliveredMessages = await Message.find({
        receiver: userId,
        status: "sent",
      });

      if (undeliveredMessages.length > 0) {
        await Message.updateMany(
          { receiver: userId, status: "sent" },
          { $set: { status: "delivered", updatedAt: new Date() } },
        );

        const senderIds = [
          ...new Set(undeliveredMessages.map((msg) => msg.sender.toString())),
        ];

        senderIds.forEach((senderId) => {
          const senderSockets = userSocketMap.get(senderId) || new Set();
          senderSockets.forEach((sockId) =>
            io.to(sockId).emit("message-status-update", {
              senderId,
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

    socket.on("connection-request-sent", ({ receiverId, requestData }) => {
      emitToUser(receiverId, "connection-request-received", requestData);
    });

    socket.on("connection-request-accepted", ({ requesterId, connectionData }) => {
      emitToUser(requesterId, "connection-accepted", connectionData);
    });

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
        const normalizedUserId = normalizeId(userId);
        const activeCallId = activeCallByUser.get(normalizedUserId);
        if (activeCallId) {
          const session = activeCallById.get(activeCallId);
          const peerId =
            session?.callerId === normalizedUserId
              ? session?.receiverId
              : session?.callerId;

          if (session?.phase === "connected") {
            // DO NOT emit call:end. P2P connection can survive websocket disconnects.
            console.log(`[Call Rescue] User ${normalizedUserId} disconnected in connected call. Leaving WebRTC intact.`);
            // Keep the active session in memory so call:is-active probes continue
            // to return true while media is still flowing.
            const now = Date.now();
            const updatedSession = {
              ...session,
              updatedAtMs: now,
              disconnectedAtByUser: {
                ...(session.disconnectedAtByUser || {}),
                [normalizedUserId]: now,
              },
            };
            activeCallById.set(activeCallId, updatedSession);
          } else if (peerId) {
            emitToUserReliable(peerId, "call:end", {
              from: normalizedUserId,
              callId: activeCallId,
            });
            clearActiveCallById(activeCallId);
          } else {
            clearActiveCallById(activeCallId);
          }
        }
      }
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
    socket.on("call:initiate", async ({ receiverId, callType }, ack) => {
      try {
        const normalizedCallerId = normalizeId(userId);
        const normalizedReceiverId = normalizeId(receiverId);
        const supportedCallType =
          callType === "audio" || callType === "video" ? callType : "audio";

        if (!normalizedCallerId || !normalizedReceiverId) {
          if (typeof ack === "function") {
            ack({ ok: false, reason: "invalid_participant" });
          }
          return;
        }

        if (normalizedCallerId === normalizedReceiverId) {
          if (typeof ack === "function") {
            ack({ ok: false, reason: "self_call_not_allowed" });
          }
          return;
        }

        const pairKey = getCallPairKey(
          normalizedCallerId,
          normalizedReceiverId,
        );

        const result = await withUsersCallLock(
          [normalizedCallerId, normalizedReceiverId],
          async () => withCallPairLock(pairKey, async () => {
          const caller = await User.findById(
            normalizedCallerId,
            "firstName lastName image email",
          );
          if (!caller) return null;

          const ringingWindowStart = new Date(
            Date.now() - RINGING_CALL_REUSE_WINDOW_MS,
          );

          let call = await Call.findOne({
            status: "ongoing",
            endedAt: null,
            connectedAt: null,
            startedAt: { $gte: ringingWindowStart },
            $or: [
              {
                callerId: normalizedCallerId,
                receiverId: normalizedReceiverId,
              },
              {
                callerId: normalizedReceiverId,
                receiverId: normalizedCallerId,
              },
            ],
          })
            .sort({ startedAt: -1 })
            .exec();

          let createdNewCall = false;
          if (!call) {
            const eitherUserBusy = isUserBusyInActiveCall(
              normalizedCallerId,
              normalizedReceiverId,
            );
            if (eitherUserBusy) {
              await reconcileBusyUsersWithDb(
                normalizedCallerId,
                normalizedReceiverId,
              );
            }

            const stillBusyAfterReconcile = isUserBusyInActiveCall(
              normalizedCallerId,
              normalizedReceiverId,
            );
            if (stillBusyAfterReconcile) {
              return {
                ok: false,
                reason: "user_busy",
              };
            }

            // DB fallback: if in-memory active-call maps are cold/out-of-sync (e.g. restart
            // or reconnect races), still block new calls to users already in ongoing calls.
            const blockingCall = await findBlockingCallInDb(
              normalizedCallerId,
              normalizedReceiverId,
            );
            if (blockingCall) {
              const blockingCallId = normalizeId(blockingCall._id);
              const blockingCallerId = normalizeId(blockingCall.callerId);
              const blockingReceiverId = normalizeId(blockingCall.receiverId);
              const isBlockingSamePair =
                (blockingCallerId === normalizedCallerId &&
                  blockingReceiverId === normalizedReceiverId) ||
                (blockingCallerId === normalizedReceiverId &&
                  blockingReceiverId === normalizedCallerId);

              // Recovery path: abrupt app/phone shutdown can leave a connected
              // DB call stuck as "ongoing". If the blocker is the same pair and
              // no live in-memory session points to it, mark it completed so
              // users are not permanently locked as "busy".
              const hasLiveInMemorySession =
                Boolean(
                  blockingCallId &&
                    activeCallById.get(blockingCallId) &&
                    isConnectedSessionLikelyAlive(
                      activeCallById.get(blockingCallId),
                      normalizedCallerId,
                    ) &&
                    activeCallByUser.get(blockingCallerId) ===
                      blockingCallId &&
                    activeCallByUser.get(blockingReceiverId) ===
                      blockingCallId,
                );

              if (
                isBlockingSamePair &&
                Boolean(blockingCall.connectedAt) &&
                blockingCallId &&
                !hasLiveInMemorySession
              ) {
                try {
                  const staleQuery = buildCallQuery(blockingCallId);
                  if (staleQuery) {
                    await Call.findOneAndUpdate(staleQuery, {
                      status: "completed",
                      endedAt: new Date(),
                    });
                  }
                } catch (staleCleanupError) {
                  console.error(
                    "Failed recovering stale same-pair connected call:",
                    staleCleanupError,
                  );
                }
                clearActiveCallById(blockingCallId);
              } else {
              if (blockingCallId && blockingCallerId && blockingReceiverId) {
                upsertActiveCall(
                  blockingCallId,
                  blockingCallerId,
                  blockingReceiverId,
                  blockingCall.connectedAt ? "connected" : "ringing",
                );
              }
              return {
                ok: false,
                reason: "user_busy",
              };
              }
            }

            call = await Call.create({
              callId: crypto.randomUUID(),
              callerId: normalizedCallerId,
              receiverId: normalizedReceiverId,
              callType: supportedCallType,
              status: "ongoing",
              startedAt: new Date(),
            });
            createdNewCall = true;
          }

          const callId = call._id.toString();
          const persistedCallerId = normalizeId(call.callerId);
          const persistedReceiverId = normalizeId(call.receiverId);
          const persistedCallType = call.callType;
          const isAlreadyConnected = Boolean(call.connectedAt);
          upsertActiveCall(
            callId,
            persistedCallerId,
            persistedReceiverId,
            isAlreadyConnected ? "connected" : "ringing",
          );
          if (isAlreadyConnected) {
            clearRingingTimeout(callId);
          } else {
            scheduleRingingTimeout(callId);
          }

          const sessionBase = {
            callId,
            callerId: persistedCallerId,
            receiverId: persistedReceiverId,
            callType: persistedCallType,
          };

          emitToUser(persistedCallerId, "call:session", {
            ...sessionBase,
            isCaller: true,
          });
          emitToUser(persistedReceiverId, "call:session", {
            ...sessionBase,
            isCaller: false,
          });

          const shouldNotifyIncoming = !isAlreadyConnected;
          if (shouldNotifyIncoming) {
            // For reused ringing calls, always preserve caller identity from persisted call
            // so accept/signaling semantics remain stable.
            let persistedCaller = caller;
            if (persistedCallerId !== normalizedCallerId) {
              persistedCaller = await User.findById(
                persistedCallerId,
                "firstName lastName image email",
              );
            }

            const incomingPayload = {
              callId,
              callerId: persistedCallerId,
              callType: persistedCallType,
              callerName:
                `${persistedCaller?.firstName || "Unknown"} ${persistedCaller?.lastName || ""}`.trim(),
              callerImage: persistedCaller?.image || "",
              callerEmail: persistedCaller?.email || "",
            };

            emitToUser(persistedReceiverId, "incoming-call", incomingPayload);

            const receiverSockets =
              userSocketMap.get(persistedReceiverId) || new Set();
            if (receiverSockets.size === 0) {
              (async () => {
                const receiverUser =
                  await User.findById(persistedReceiverId).select("pushTokens");
                const pushTokens = receiverUser?.pushTokens || [];
                void sendPushToTokens({
                  tokens: pushTokens,
                  title: "Incoming call",
                  body: `${incomingPayload.callerName} is calling you.`,
                  imageUrl: incomingPayload.callerImage || undefined,
                  data: {
                    type: "call",
                    callId: incomingPayload.callId,
                    callerId: incomingPayload.callerId,
                    callType: incomingPayload.callType,
                    callerName: incomingPayload.callerName || "Unknown",
                    callerImage: incomingPayload.callerImage || "",
                    callerEmail: incomingPayload.callerEmail || "",
                    url: `/chats?type=call&callId=${incomingPayload.callId}&callerId=${incomingPayload.callerId}&callType=${incomingPayload.callType}`,
                  },
                });
              })().catch((pushError) => {
                console.error("Incoming call push dispatch failed:", pushError);
              });
            }
          }

          return {
            ok: true,
            ...sessionBase,
            isCaller: persistedCallerId === normalizedCallerId,
            reusedExistingCall: !createdNewCall,
          };
        }),
        );

        if (!result) {
          if (typeof ack === "function") {
            ack({ ok: false, reason: "caller_not_found" });
          }
          return;
        }

        if (typeof ack === "function") {
          ack(result);
        }
      } catch (err) {
        console.error("Call initiate error:", err);
        if (typeof ack === "function") {
          ack({ ok: false, reason: "server_error" });
        }
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
        if (resolvedCallId && targetCallerId && receiverId) {
          upsertActiveCall(
            resolvedCallId,
            targetCallerId,
            receiverId,
            "connected",
          );
          clearRingingTimeout(resolvedCallId);
        }

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
      const resolvedCallId = call?._id?.toString() || callId;
      const targetCallerId = callerId || call?.callerId?.toString();
      if (resolvedCallId) {
        clearRingingTimeout(resolvedCallId);
        clearActiveCallById(resolvedCallId);
      } else if (targetCallerId) {
        clearActiveCallForPair(userId, targetCallerId);
      }
      if (targetCallerId) {
        emitToUser(targetCallerId, "call-rejected", { callId });
      }
    });

    // End Call (Hangup)
    socket.on("call:end", async ({ to, callId }) => {
      const normalizedTo = normalizeId(to);
      let resolvedCallId = normalizeId(callId);

      if (!resolvedCallId && normalizedTo) {
        const pairCall = await Call.findOne({
          status: "ongoing",
          endedAt: null,
          $or: [
            { callerId: userId, receiverId: normalizedTo },
            { callerId: normalizedTo, receiverId: userId },
          ],
        })
          .sort({ connectedAt: -1, startedAt: -1 })
          .select("_id")
          .lean();
        resolvedCallId = pairCall?._id?.toString() || "";
      }

      if (resolvedCallId) {
        clearRingingTimeout(resolvedCallId);
        clearActiveCallById(resolvedCallId);
      } else if (normalizedTo) {
        clearActiveCallForPair(userId, normalizedTo);
      }

      // Notify the other user immediately on both event names:
      //   "call:end"    → IncomingCallOverlay (web) + NativeCallHandler (native signaling)
      // NOTE: We deliberately do NOT emit "call-ended" here. Emitting call-ended causes
      // SocketContext to call clearActiveCall() on the recipient, which unmounts VideoCallScreen
      // mid-call and stops the local camera tracks. The call:end event is sufficient:
      //   - IncomingCallOverlay listens to call:end directly
      //   - NativeCallHandler listens to call:end directly
      //   - SocketContext's call:end handler now always clears incomingCall
      if (normalizedTo) {
        emitToUserReliable(normalizedTo, "call:end", {
          from: userId,
          ...(resolvedCallId ? { callId: resolvedCallId } : {}),
        });
      }

      // Clean up Database
      if (resolvedCallId) {
        await finalizeCallRecord({
          callId: resolvedCallId,
          requesterId: userId,
          peerId: normalizedTo,
          reason: "hangup",
        });
      }
    });

    socket.on(
      "call:finalize",
      async ({ to, callId, peerId, endedAt, reason, duration } = {}, ack) => {
        try {
          const normalizedPeerId = normalizeId(peerId || to);
          let resolvedCallId = normalizeId(callId);

          if (!resolvedCallId && normalizedPeerId) {
            const pairCall = await Call.findOne({
              status: "ongoing",
              endedAt: null,
              $or: [
                { callerId: userId, receiverId: normalizedPeerId },
                { callerId: normalizedPeerId, receiverId: userId },
              ],
            })
              .sort({ connectedAt: -1, startedAt: -1 })
              .select("_id")
              .lean();
            resolvedCallId = pairCall?._id?.toString() || "";
          }

          const finalizeResult = await finalizeCallRecord({
            callId: resolvedCallId || undefined,
            requesterId: userId,
            peerId: normalizedPeerId || undefined,
            endedAt,
            reason: reason || "hangup",
            duration,
          });

          if (!finalizeResult.ok) {
            if (typeof ack === "function") {
              ack(finalizeResult);
            }
            return;
          }

          const finalCallId =
            normalizeId(finalizeResult.callId) || resolvedCallId;

          if (finalCallId) {
            clearRingingTimeout(finalCallId);
            clearActiveCallById(finalCallId);
          } else if (normalizedPeerId) {
            clearActiveCallForPair(userId, normalizedPeerId);
          }

          // Only notify peer on first finalize. Replays/duplicates should not
          // send a late call:end that can race against newer calls.
          if (
            normalizedPeerId &&
            !finalizeResult.alreadyFinalized
          ) {
            emitToUserReliable(normalizedPeerId, "call:end", {
              from: userId,
              ...(finalCallId ? { callId: finalCallId } : {}),
            });
          }

          if (typeof ack === "function") {
            ack({
              ok: true,
              ...finalizeResult,
            });
          }
        } catch (error) {
          console.error("Call finalize error:", error);
          if (typeof ack === "function") {
            ack({ ok: false, reason: "server_error" });
          }
        }
      },
    );

    // Offer (Handling "Polite" vs "Impolite")
    // Note: We use 'description' now instead of just 'offer' to be generic
    socket.on("call:offer", ({ to, description, callId }) => {
      emitToUser(to, "call:offer", {
        description,
        from: userId,
        callId: normalizeId(callId) || undefined,
      });
    });

    // Answer
    socket.on("call:answer", ({ to, description, callId }) => {
      emitToUser(to, "call:answer", {
        description,
        from: userId,
        callId: normalizeId(callId) || undefined,
      });
    });

    // ICE Candidates
    socket.on("call:ice-candidate", ({ to, candidate, callId }) => {
      emitToUser(to, "call:ice-candidate", {
        candidate,
        from: userId,
        callId: normalizeId(callId) || undefined,
      });
    });

    socket.on("call:ice-candidates", ({ to, candidates, callId }) => {
      if (!Array.isArray(candidates) || candidates.length === 0) return;
      emitToUser(to, "call:ice-candidates", {
        candidates,
        from: userId,
        callId: normalizeId(callId) || undefined,
      });
    });

    socket.on(
      "call:media-state",
      ({ to, callId, videoOff, videoSource, screenShareActive, mediaSeq }) => {
        const normalizedTo = normalizeId(to);
        if (!normalizedTo) return;
        const normalizedCallId = normalizeId(callId);
        const normalizedMediaState = normalizeCallMediaState({
          videoOff,
          videoSource,
          screenShareActive,
        });
        if (normalizedCallId) {
          upsertCallMediaState(normalizedCallId, userId, {
            ...normalizedMediaState,
            mediaSeq,
          });
        }
        emitToUserReliable(normalizedTo, "call:media-state", {
          from: userId,
          callId: normalizedCallId || undefined,
          ...normalizedMediaState,
          ...(Number.isFinite(Number(mediaSeq))
            ? { mediaSeq: Number(mediaSeq) }
            : {}),
        });
      },
    );

    socket.on("call:heartbeat", ({ callId, peerId } = {}, ack) => {
      try {
        const requesterId = normalizeId(userId);
        const normalizedCallId = normalizeId(callId);
        const normalizedPeerId = normalizeId(peerId);
        if (!requesterId) {
          if (typeof ack === "function") ack({ ok: false });
          return;
        }

        const isParticipantMatch = (callerId, receiverId) => {
          const caller = normalizeId(callerId);
          const receiver = normalizeId(receiverId);
          if (!caller || !receiver) return false;
          const requesterInCall =
            caller === requesterId || receiver === requesterId;
          if (!requesterInCall) return false;
          if (!normalizedPeerId) return true;
          return caller === normalizedPeerId || receiver === normalizedPeerId;
        };

        let resolvedCallId = normalizedCallId;
        let session = resolvedCallId ? activeCallById.get(resolvedCallId) : null;

        if (!session) {
          const userMappedCallId = activeCallByUser.get(requesterId);
          if (userMappedCallId) {
            const mappedSession = activeCallById.get(userMappedCallId);
            if (
              mappedSession &&
              isParticipantMatch(mappedSession.callerId, mappedSession.receiverId)
            ) {
              resolvedCallId = userMappedCallId;
              session = mappedSession;
            }
          }
        }

        if (session && resolvedCallId) {
          const now = Date.now();
          const updatedSession = {
            ...session,
            updatedAtMs: now,
            lastHeartbeatByUser: {
              ...(session.lastHeartbeatByUser || {}),
              [requesterId]: now,
            },
            disconnectedAtByUser: {
              ...(session.disconnectedAtByUser || {}),
            },
          };
          delete updatedSession.disconnectedAtByUser[requesterId];
          activeCallById.set(resolvedCallId, updatedSession);
          if (typeof ack === "function") {
            ack({ ok: true, callId: resolvedCallId });
          }
          return;
        }

        if (typeof ack === "function") {
          ack({ ok: false });
        }
      } catch (error) {
        console.error("call:heartbeat failed:", error);
        if (typeof ack === "function") {
          ack({ ok: false });
        }
      }
    });

    socket.on("call:is-active", async ({ callId, peerId } = {}, ack) => {
      if (typeof ack !== "function") return;
      try {
        const requesterId = normalizeId(userId);
        const normalizedPeerId = normalizeId(peerId);
        const normalizedCallId = normalizeId(callId);

        const isParticipantMatch = (
          callerId,
          receiverId,
          requirePeerMatch = false,
        ) => {
          const caller = normalizeId(callerId);
          const receiver = normalizeId(receiverId);
          if (!requesterId || !caller || !receiver) return false;
          const requesterInCall =
            caller === requesterId || receiver === requesterId;
          if (!requesterInCall) return false;
          if (!requirePeerMatch || !normalizedPeerId) return true;
          return caller === normalizedPeerId || receiver === normalizedPeerId;
        };

        const isSessionLikelyAliveForRequester = (session, resolvedCallId) => {
          if (!session || !resolvedCallId) return false;
          if (isConnectedSessionLikelyAlive(session, requesterId)) {
            return true;
          }
          clearActiveCallById(resolvedCallId);
          return false;
        };

        if (normalizedCallId) {
          const session = activeCallById.get(normalizedCallId);
          if (
            session &&
            isParticipantMatch(session.callerId, session.receiverId, false) &&
            isSessionLikelyAliveForRequester(session, normalizedCallId)
          ) {
            ack({ active: true, callId: normalizedCallId });
            return;
          }
        } else if (requesterId) {
          const activeCallId = activeCallByUser.get(requesterId);
          if (activeCallId) {
            const session = activeCallById.get(activeCallId);
            if (
              session &&
              isParticipantMatch(session.callerId, session.receiverId, true) &&
              isSessionLikelyAliveForRequester(session, activeCallId)
            ) {
              ack({ active: true, callId: activeCallId });
              return;
            }
          }
        }

        let dbCall = null;
        if (normalizedCallId) {
          const query = buildCallQuery(normalizedCallId);
          dbCall = query
            ? await Call.findOne(query)
                .select(
                  "_id callerId receiverId callType connectedAt startedAt status endedAt",
                )
                .lean()
            : null;
        }

        if (
          (!dbCall || !isCallRecordPotentiallyActive(dbCall)) &&
          requesterId &&
          normalizedPeerId
        ) {
          dbCall = await Call.findOne({
            status: "ongoing",
            endedAt: null,
            $or: [
              { callerId: requesterId, receiverId: normalizedPeerId },
              { callerId: normalizedPeerId, receiverId: requesterId },
            ],
          })
            .sort({ connectedAt: -1, startedAt: -1 })
            .select(
              "_id callerId receiverId callType connectedAt startedAt status endedAt",
            )
            .lean();
        }

        if (
          dbCall &&
          isCallRecordPotentiallyActive(dbCall) &&
          isParticipantMatch(
            dbCall.callerId,
            dbCall.receiverId,
            !normalizedCallId,
          )
        ) {
          const dbCallId = normalizeId(dbCall._id);
          if (dbCallId) {
            upsertActiveCall(
              dbCallId,
              normalizeId(dbCall.callerId),
              normalizeId(dbCall.receiverId),
              dbCall.connectedAt ? "connected" : "ringing",
            );
          }
          ack({
            active: true,
            callId: dbCallId || undefined,
          });
          return;
        }

        if (normalizedCallId) {
          clearActiveCallById(normalizedCallId);
        }
        ack({ active: false });
      } catch (error) {
        console.error("Call active probe failed:", error);
        // Fail-safe: avoid dropping a healthy call on probe errors.
        ack({ active: true });
      }
    });

    socket.on("call:resync", async ({ callId, peerId } = {}, ack) => {
      if (typeof ack !== "function") return;
      try {
        const requesterId = normalizeId(userId);
        const normalizedCallId = normalizeId(callId);
        const normalizedPeerId = normalizeId(peerId);
        if (!requesterId) {
          ack({ active: false });
          return;
        }

        const isParticipantMatch = (callerId, receiverId) => {
          const caller = normalizeId(callerId);
          const receiver = normalizeId(receiverId);
          if (!caller || !receiver) return false;
          const requesterInCall =
            caller === requesterId || receiver === requesterId;
          if (!requesterInCall) return false;
          if (!normalizedPeerId) return true;
          return caller === normalizedPeerId || receiver === normalizedPeerId;
        };

        let resolvedCallId = "";
        let session = null;

        if (normalizedCallId) {
          const inMemorySession = activeCallById.get(normalizedCallId);
          if (
            inMemorySession &&
            isParticipantMatch(
              inMemorySession.callerId,
              inMemorySession.receiverId,
            )
          ) {
            resolvedCallId = normalizedCallId;
            session = inMemorySession;
          }
        }

        if (!session) {
          const activeCallId = activeCallByUser.get(requesterId);
          if (activeCallId) {
            const inMemorySession = activeCallById.get(activeCallId);
            if (
              inMemorySession &&
              isParticipantMatch(
                inMemorySession.callerId,
                inMemorySession.receiverId,
              )
            ) {
              resolvedCallId = activeCallId;
              session = inMemorySession;
            }
          }
        }

        if (!session) {
          let dbCall = null;
          if (normalizedCallId) {
            const query = buildCallQuery(normalizedCallId);
            dbCall = query
              ? await Call.findOne(query)
                  .select(
                    "_id callerId receiverId callType connectedAt startedAt status endedAt",
                  )
                  .lean()
              : null;
          }

          if (
            (!dbCall || !isCallRecordPotentiallyActive(dbCall)) &&
            requesterId &&
            normalizedPeerId
          ) {
            dbCall = await Call.findOne({
              status: "ongoing",
              endedAt: null,
              $or: [
                { callerId: requesterId, receiverId: normalizedPeerId },
                { callerId: normalizedPeerId, receiverId: requesterId },
              ],
            })
              .sort({ connectedAt: -1, startedAt: -1 })
              .select(
                "_id callerId receiverId callType connectedAt startedAt status endedAt",
              )
              .lean();
          }

          if (
            dbCall &&
            isCallRecordPotentiallyActive(dbCall) &&
            isParticipantMatch(dbCall.callerId, dbCall.receiverId)
          ) {
            const dbCallId = normalizeId(dbCall._id);
            const callerId = normalizeId(dbCall.callerId);
            const receiverId = normalizeId(dbCall.receiverId);
            if (dbCallId && callerId && receiverId) {
              upsertActiveCall(
                dbCallId,
                callerId,
                receiverId,
                dbCall.connectedAt ? "connected" : "ringing",
              );
              resolvedCallId = dbCallId;
              session = {
                callerId,
                receiverId,
                phase: dbCall.connectedAt ? "connected" : "ringing",
              };
            }
          }
        }

        if (!session || !resolvedCallId) {
          if (normalizedCallId) {
            clearActiveCallById(normalizedCallId);
          }
          ack({ active: false });
          return;
        }

        const callerId = normalizeId(session.callerId);
        const receiverId = normalizeId(session.receiverId);
        const resolvedPeerId =
          callerId === requesterId ? receiverId : callerId;
        const peerMediaState = getCallMediaState(resolvedCallId, resolvedPeerId);
        const selfMediaState = getCallMediaState(resolvedCallId, requesterId);

        if (resolvedPeerId && peerMediaState) {
          emitToUser(requesterId, "call:media-state", {
            from: resolvedPeerId,
            callId: resolvedCallId,
            videoOff: Boolean(peerMediaState.videoOff),
            videoSource: peerMediaState.videoSource || "camera",
            screenShareActive: Boolean(peerMediaState.screenShareActive),
            ...(Number.isFinite(Number(peerMediaState.mediaSeq))
              ? { mediaSeq: Number(peerMediaState.mediaSeq) }
              : {}),
          });
        }

        ack({
          active: true,
          callId: resolvedCallId,
          phase: session.phase === "connected" ? "connected" : "ringing",
          ...(resolvedPeerId ? { peerId: resolvedPeerId } : {}),
          ...(peerMediaState
            ? {
                peerVideoOff: Boolean(peerMediaState.videoOff),
                peerVideoSource: peerMediaState.videoSource || "camera",
                peerScreenShareActive: Boolean(peerMediaState.screenShareActive),
              }
            : {}),
          ...(selfMediaState
            ? {
                selfVideoOff: Boolean(selfMediaState.videoOff),
                selfVideoSource: selfMediaState.videoSource || "camera",
                selfScreenShareActive: Boolean(selfMediaState.screenShareActive),
              }
            : {}),
        });
      } catch (error) {
        console.error("Call resync failed:", error);
        ack({ active: true });
      }
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

    socket.on("connection-request-sent", ({ receiverId }) => {
      emitToUser(receiverId, "connection-request-received", {});
    });

    socket.on("connection-request-accepted", ({ requesterId, connectionData }) => {
      emitToUser(requesterId, "connection-request-accepted", connectionData);
      
      // Fetch and send contact data to BOTH users so they appear in sidebars instantly!
      User.findById(userId).select("firstName lastName email image color lastSeen").then(user => {
        if (user) {
          emitToUser(requesterId, "new-dm-contact", {
            ...user._doc,
            lastMessage: "No messages yet",
            lastMessageAt: new Date(),
            unreadCount: 0
          });
        }
      });
      
      User.findById(requesterId).select("firstName lastName email image color lastSeen").then(requester => {
        if (requester) {
          emitToUser(userId, "new-dm-contact", {
            ...requester._doc,
            lastMessage: "No messages yet",
            lastMessageAt: new Date(),
            unreadCount: 0
          });
        }
      });
    });
  });
}

export { io, setupSocket, userSocketMap };
