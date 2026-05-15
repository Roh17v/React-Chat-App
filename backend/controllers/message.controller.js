import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { Channel } from "../models/channel.model.js";
import { uploadToStorage } from "../middlewares/upload.middleware.js";
import { io, userSocketMap } from "../socket.js";
import redis from "../config/redis.js";

export const getMessages = async (req, res, next) => {
  const { contactId } = req.params;
  const userId = req.user._id;
  let { page = 1, limit = 20 } = req.query;

  if (!contactId || !userId)
    return next(createError(400, "ContactId and userId is required."));

  try {
    page = parseInt(page);
    limit = parseInt(limit);

    const cacheKey = `chat:dm:${[userId.toString(), contactId.toString()].sort().join(":")}`;

    if (redis && page === 1) {
      const cachedMessages = await redis.lrange(cacheKey, 0, limit - 1);
      if (cachedMessages && cachedMessages.length > 0) {
        console.log(`[Redis] Serving messages for chat ${cacheKey} from cache.`);
        const parsed = cachedMessages.map((m) => JSON.parse(m));
        return res.status(200).json(parsed.reverse());
      }
    }

    const messages = await Message.find({
      $or: [
        { sender: userId, receiver: contactId },
        { sender: contactId, receiver: userId },
      ],
      deletedFor: { $ne: userId },
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Sanitize deleted-for-everyone messages
    const sanitized = messages.map((msg) => {
      if (msg.deletedForEveryone) {
        return {
          ...msg,
          content: null,
          fileUrl: null,
          fileName: null,
          messageType: msg.messageType,
        };
      }
      return msg;
    });

    const responseData = sanitized.reverse();

    if (redis && page === 1 && responseData.length > 0) {
      // Clear old cache first to avoid duplicates
      await redis.del(cacheKey);
      
      // Push to Redis (reverse back to newest first!)
      const toCache = responseData.slice().reverse().map((m) => JSON.stringify(m));
      await redis.rpush(cacheKey, ...toCache);
      await redis.expire(cacheKey, 7200); // 2 hours TTL
      console.log(`[Redis] Cached ${toCache.length} messages for chat ${cacheKey}`);
    }

    res.status(200).json(responseData);
  } catch (error) {
    next(error);
  }
};

export const uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return next(createError(400, "File is required."));
    }

    // Upload to object storage (Cloudflare R2)
    const fileUrl = await uploadToStorage(req.file, "chat-files");

    return res.status(201).json({
      success: true,
      message: "File uploaded successfully",
      fileUrl,
    });
  } catch (error) {
    console.error("Upload file error:", error);
    next(createError(500, "File upload failed."));
  }
};

export const getChannelMessages = async (req, res, next) => {
  try {
    const { channelId } = req.params;
    const userId = req.user._id;
    const { page = 1, limit = 20 } = req.query;

    if (!channelId) return next(createError(400, "Channel ID is required"));

    const messages = await Message.find({
      channelId,
      deletedFor: { $ne: userId },
    })
      .sort({ createdAt: -1 })
      .populate("sender", "_id email color firstName lastName")
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const sanitized = messages.map((msg) => {
      if (msg.deletedForEveryone) {
        return {
          ...msg,
          content: null,
          fileUrl: null,
          fileName: null,
          messageType: msg.messageType,
        };
      }
      return msg;
    });

    res.status(200).json(sanitized.reverse());
  } catch (error) {
    next(error);
  }
};

export const deleteForMe = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return next(createError(404, "Message not found."));

    // Only the sender or receiver can delete for themselves
    const isSender = message.sender.toString() === userId.toString();
    const isReceiver = message.receiver?.toString() === userId.toString();
    const isChannelMsg = !!message.channelId;

    if (!isSender && !isReceiver && !isChannelMsg) {
      return next(createError(403, "Not authorized to delete this message."));
    }

    await Message.findByIdAndUpdate(messageId, {
      $addToSet: { deletedFor: userId },
    });

    // Invalidate caches!
    if (redis) {
      await redis.del(`user:${userId}:sidebar`);
      
      // Also invalidate message cache for DMs!
      if (!isChannelMsg && message.sender && message.receiver) {
        const cacheKey = `chat:dm:${[message.sender.toString(), message.receiver.toString()].sort().join(":")}`;
        await redis.del(cacheKey);
        console.log(`[Redis] Invalidated message cache for chat ${cacheKey} (Message deleted for me).`);
      }
    }

    res.status(200).json({ success: true, messageId });
  } catch (error) {
    next(error);
  }
};

export const deleteForEveryone = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) return next(createError(404, "Message not found."));

    // Only the sender can delete for everyone
    if (message.sender.toString() !== userId.toString()) {
      return next(
        createError(403, "Only the sender can delete for everyone.")
      );
    }

    await Message.findByIdAndUpdate(messageId, {
      deletedForEveryone: true,
      deletedAt: new Date(),
      content: null,
      fileUrl: null,
      fileName: null,
    });

    // Notify all relevant users via socket
    if (message.channelId) {
      // Channel message — notify all channel members
      const channel = await Channel.findById(message.channelId).populate(
        "members"
      );
      if (channel) {
        const memberIds = new Set(
          (channel.members || []).map((m) => m._id.toString())
        );
        if (channel.admin) memberIds.add(channel.admin.toString());

        // Invalidate sidebar cache for all members!
        if (redis) {
          for (const memberId of memberIds) {
            await redis.del(`user:${memberId}:sidebar`);
          }
          console.log(`[Redis] Invalidated sidebar cache for ${memberIds.size} members of channel ${message.channelId}`);
        }

        memberIds.forEach((memberId) => {
          const sockets = userSocketMap.get(memberId) || new Set();
          sockets.forEach((socketId) => {
            io.to(socketId).emit("message-deleted", {
              messageId,
              chatType: "channel",
              channelId: message.channelId.toString(),
            });
          });
        });
      }
    } else {
      // DM — notify sender + receiver
      const participants = [
        message.sender.toString(),
        message.receiver.toString(),
      ];
      
      // Invalidate message and sidebar cache!
      if (redis) {
        const cacheKey = `chat:dm:${[message.sender.toString(), message.receiver.toString()].sort().join(":")}`;
        await redis.del(cacheKey);
        await redis.del(`user:${message.sender}:sidebar`);
        await redis.del(`user:${message.receiver}:sidebar`);
        console.log(`[Redis] Invalidated caches for chat ${cacheKey} (Message deleted for everyone).`);
      }

      participants.forEach((uid) => {
        const sockets = userSocketMap.get(uid) || new Set();
        sockets.forEach((socketId) => {
          io.to(socketId).emit("message-deleted", {
            messageId,
            chatType: "contact",
            contactId:
              uid === message.sender.toString()
                ? message.receiver.toString()
                : message.sender.toString(),
          });
        });
      });
    }

    res.status(200).json({ success: true, messageId });
  } catch (error) {
    next(error);
  }
};
