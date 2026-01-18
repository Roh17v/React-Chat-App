import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { Channel } from "../models/channel.model.js";
import { uploadToStorage } from "../middlewares/upload.middleware.js";

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
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.status(200).json(messages.reverse());
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
    const { page = 1, limit = 20 } = req.query;

    if (!channelId) return next(createError(400, "Channel ID is required"));

    const messages = await Message.find({ channelId })
      .sort({ createdAt: -1 })
      .populate("sender", "_id email color firstName lastName")
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    res.status(200).json(messages.reverse());
  } catch (error) {
    next(error);
  }
};
