import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { mkdirSync, renameSync } from "fs";
import { Channel } from "../models/channel.model.js";

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
  const userId = req.user._id;

  try {
    if (!req.file) return next(createError(400, "File is Required."));
    const date = Date.now();
    let fileDir = `uploads/files/${date}`;
    let fileName = `${fileDir}/${req.file.originalname}`;

    mkdirSync(fileDir, { recursive: true });

    renameSync(req.file.path, fileName);

    return res.status(201).json({ filePath: fileName });
  } catch (error) {
    next(error);
  }
};

export const getChannelMessages = async (req, res, next) => {
  const { channelId } = req.params;
  const userId = req.user?._id;

  if (!channelId || !userId) {
    return next(createError(400, "ChannelId and userId are required."));
  }

  try {
    const channelMessages = await Channel.findById(channelId).populate({
      path: "message",
      populate: {
        path: "sender",
        select: "id email firstName lastName image color",
      },
    });

    if (!channelMessages) {
      return next(createError(404, "Channel not found."));
    }

    res.status(200).json(channelMessages.message);
  } catch (error) {
    next(error);
  }
};
