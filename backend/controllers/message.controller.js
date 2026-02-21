import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { Channel } from "../models/channel.model.js";
import { uploadToStorage } from "../middlewares/upload.middleware.js";
import { io, userSocketMap } from "../socket.js";

export const getMessages = async (req, res, next) => {
  const { contactId } = req.params;
  const userId = req.user._id;
  let { page = 1, limit = 20 } = req.query;

  if (!contactId || !userId)
    return next(createError(400, "ContactId and userId is required."));

  try {
    page = parseInt(page);
    limit = parseInt(limit);

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
