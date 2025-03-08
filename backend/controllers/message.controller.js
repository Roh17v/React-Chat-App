import Message from "../models/message.model.js";
import { createError } from "../utils/error.js";

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
