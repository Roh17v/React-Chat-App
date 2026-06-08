import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { Channel } from "../models/channel.model.js";
import { uploadToStorage } from "../middlewares/upload.middleware.js";
import { io, userSocketMap } from "../socket.js";


// Limits for paginated message reads (Req 13.4). When `since` is supplied the
// client paginates by advancing the cursor and we cap the page size at 200; when
// `since` is omitted we preserve the legacy page+limit behavior.
const DEFAULT_MESSAGES_LIMIT = 50;
const MAX_MESSAGES_LIMIT = 200;

const sanitizeDeleted = (msg) => {
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
};

const parseLimit = (raw) => {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MESSAGES_LIMIT;
  return Math.min(parsed, MAX_MESSAGES_LIMIT);
};

export const getMessages = async (req, res, next) => {
  const { contactId } = req.params;
  const userId = req.user._id;
  let { page = 1, limit, since } = req.query;

  if (!contactId || !userId)
    return next(createError(400, "ContactId and userId is required."));

  try {
    page = parseInt(page, 10);
    if (!Number.isFinite(page) || page <= 0) page = 1;
    limit = parseLimit(limit);

    const baseQuery = {
      $or: [
        { sender: userId, receiver: contactId },
        { sender: contactId, receiver: userId },
      ],
      deletedFor: { $ne: userId },
    };

    let messages;
    if (since !== undefined && since !== "") {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return next(createError(400, "Invalid `since` timestamp."));
      }
      // Incremental-sync path: ascending by updatedAt, no skip/page semantics
      // (the client paginates by advancing `since`). Req 13.1, 13.3, 13.4.
      messages = await Message.find({
        ...baseQuery,
        updatedAt: { $gt: sinceDate },
      })
        .sort({ updatedAt: 1 })
        .limit(limit)
        .lean();
    } else {
      // Legacy path preserved for existing clients (Req 13.4).
      messages = await Message.find(baseQuery)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
    }

    // Sanitize deleted-for-everyone messages. `updatedAt` is included via
    // `{ timestamps: true }` on the schema and survives `.lean()` (Req 13.5).
    const sanitized = messages.map(sanitizeDeleted);

    const responseData = since ? sanitized : sanitized.reverse();

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
    let { page = 1, limit, since } = req.query;

    if (!channelId) return next(createError(400, "Channel ID is required"));

    page = parseInt(page, 10);
    if (!Number.isFinite(page) || page <= 0) page = 1;
    limit = parseLimit(limit);

    const baseQuery = {
      channelId,
      deletedFor: { $ne: userId },
    };

    let messages;
    if (since !== undefined && since !== "") {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return next(createError(400, "Invalid `since` timestamp."));
      }
      // Incremental-sync path: ascending by createdAt (Req 13.2, 13.3, 13.4).
      messages = await Message.find({
        ...baseQuery,
        createdAt: { $gt: sinceDate },
      })
        .sort({ createdAt: 1 })
        .populate("sender", "_id email color firstName lastName")
        .limit(limit)
        .lean();
    } else {
      // Legacy path preserved for existing clients (Req 13.4).
      messages = await Message.find(baseQuery)
        .sort({ createdAt: -1 })
        .populate("sender", "_id email color firstName lastName")
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
    }

    // `updatedAt` is included via `{ timestamps: true }` on the schema (Req 13.5).
    const sanitized = messages.map(sanitizeDeleted);

    const responseData = since ? sanitized : sanitized.reverse();

    res.status(200).json(responseData);
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

/**
 * POST /api/messages/mark-read/:contactId
 *
 * Durable counterpart of the `confirm-read` socket event. Flips every
 * unread DM the authenticated user received from `contactId` to
 * `status: "read"` and notifies both peers so their UIs reconcile.
 *
 * Why both REST and socket:
 *   - Socket emit is fire-and-forget — if the socket is mid-reconnect
 *     when the user opens a chat, the read receipt is lost and the
 *     unread count gets stuck.
 *   - REST is durable: 200 means the DB was updated. The native
 *     OutboundQueue can retry it on reconnect, so unread state survives
 *     even if the user closes the app immediately after opening a chat.
 *
 * The handler is intentionally idempotent: rerunning it on an already-
 * read conversation is a no-op (the `$in: ["sent", "delivered"]` filter
 * matches nothing).
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export const markRead = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { contactId } = req.params;

    if (!contactId) {
      return next(createError(400, "contactId is required."));
    }

    const result = await Message.updateMany(
      {
        receiver: userId,
        sender: contactId,
        status: { $in: ["sent", "delivered"] },
      },
      { $set: { status: "read", updatedAt: new Date() } },
    );

    // Notify both peers via socket so any open client window updates
    // immediately (the chat list and any open chat view both listen for
    // `message-status-update`). Mirrors the post-update emits inside the
    // `updateMessageStatusToRead` socket helper.
    if (result.modifiedCount > 0) {
      const senderSockets = userSocketMap.get(contactId.toString()) || new Set();
      const receiverSockets = userSocketMap.get(userId.toString()) || new Set();
      const payload = {
        senderId: contactId.toString(),
        receiverId: userId.toString(),
        status: "read",
      };
      senderSockets.forEach((socketId) => {
        io.to(socketId).emit("message-status-update", payload);
      });
      receiverSockets.forEach((socketId) => {
        io.to(socketId).emit("message-status-update", payload);
      });
    }

    res.status(200).json({
      success: true,
      modifiedCount: result.modifiedCount || 0,
    });
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

/**
 * GET /api/messages/updates?since=<ISO_TIMESTAMP>&limit=<N>
 *
 * Unified incremental sync feed — returns ALL new messages for the
 * authenticated user across every conversation (DMs + channels) in a
 * single query. Replaces the per-conversation loop the client used to
 * run, reducing N network round-trips to one.
 *
 * The client groups the flat array by conversationId and calls
 * `repository.applyServerMessages()` per group — the repository layer
 * (SQLite schema, conflict resolver, cursor advancement) is unchanged.
 *
 * Query design:
 *   - DMs:      sender = userId  OR  receiver = userId
 *   - Channels: channelId ∈ channels where userId is member OR admin
 *   - Filter:   updatedAt > since  AND  deletedFor ∉ userId
 *   - Sort:     updatedAt ASC  (matches what applyServerMessages expects)
 *   - Limit:    default 500, max 1 000 — hasMore signals pagination need
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export const getUnifiedUpdates = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { since } = req.query;
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 1000)
      : 500;

    // `since` is required — the client always has lastIncrementalSyncAt
    // from a prior bootstrap or incremental pass.
    if (!since || since === "") {
      return next(createError(400, "`since` query parameter is required."));
    }
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      return next(createError(400, "Invalid `since` timestamp."));
    }

    // 1. Resolve channels the user belongs to (member or admin).
    //    A single lightweight query — only `_id` is needed.
    const userChannels = await Channel.find({
      $or: [{ members: userId }, { admin: userId }],
    })
      .select("_id")
      .lean();
    const channelIds = userChannels.map((c) => c._id);

    // 2. Single cross-conversation query.
    //    MongoDB evaluates each branch of $or with its own index:
    //    - sender branch   → { sender: 1, createdAt: -1 }  (already exists)
    //    - receiver branch → { receiver: 1, createdAt: 1 } (added in model)
    //    - channelId branch→ { channelId: 1, createdAt: -1 } (already exists)
    const serverTimestamp = new Date().toISOString();
    const messages = await Message.find({
      updatedAt: { $gt: sinceDate },
      deletedFor: { $ne: userId },
      $or: [
        { sender: userId },
        { receiver: userId },
        ...(channelIds.length > 0 ? [{ channelId: { $in: channelIds } }] : []),
      ],
    })
      .sort({ updatedAt: 1 })   // ascending — what applyServerMessages expects
      .limit(limit)
      .populate("sender", "_id email color firstName lastName image lastSeen")
      .lean();

    const sanitized = messages.map(sanitizeDeleted);

    // `syncedUpTo` lets the client advance `since` on the next page
    // without re-reading its own state.
    const syncedUpTo =
      sanitized.length > 0
        ? sanitized[sanitized.length - 1].updatedAt
        : since;

    return res.status(200).json({
      messages: sanitized,
      hasMore: messages.length === limit,
      syncedUpTo,
      serverTimestamp,
    });
  } catch (error) {
    next(error);
  }
};

