import { response } from "express";
import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";
import { mkdirSync, renameSync } from "fs";

export const getMessages = async (req, res, next) => {
  const { contactId } = req.params;
  const userId = req.user._id;

  if (!contactId || !userId)
    return next(createError(400, "ContactId and userId is required."));

  try {
    const messages = await Message.find({
      $or: [
        { sender: userId, receiver: contactId },
        { sender: contactId, receiver: userId },
      ],
    }).sort({ createdAt: 1 });

    res.status(200).json(messages);
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
