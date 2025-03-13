import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import { Channel } from "../models/channel.model.js";

export const createChannel = async (req, res, next) => {
  try {
    const { channelName, members } = req.body;

    const userId = req.user._id;

    const admin = await User.findById(userId);

    if (!admin) return next(createError(400, "Admin User not Found!"));

    const validMembers = await User.find({ _id: { $in: members } }, "_id");

    if (validMembers.length !== members.length) {
      return next(createError(400, "All Members are not valid Users."));
    }

    const newChannel = new Channel({
      channelName: channelName,
      members: members,
      admin: userId,
    });

    const result = await newChannel.save();

    return res.status(201).json({ channel: result });
  } catch (error) {
    next(error);
  }
};

export const getUserChannels = async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (!userId) return next(createError(400, "User Id not found."));

    const userChannels = await Channel.find({
      $or: [{ admin: userId }, { members: userId }],
    }).sort({ updatedAt: -1 });

    res.status(200).json(userChannels);
  } catch (error) {
    next(error);
  }
};
