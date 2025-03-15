import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { mkdirSync, renameSync } from "fs";
import { Channel } from "../models/channel.model.js";
import { populate } from "dotenv";
import path from "path";

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
