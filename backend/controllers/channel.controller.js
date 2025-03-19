import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import { Channel } from "../models/channel.model.js";
import { io, userSocketMap } from "../socket.js";

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
      channelName,
      members,
      admin: userId,
    });

    const result = await newChannel.save();

    await User.updateMany(
      { _id: { $in: members } },
      { $addToSet: { channels: result._id } }
    );

    await User.findByIdAndUpdate(userId, {
      $addToSet: { channels: result._id },
    });

    members.forEach((memberId) => {
      const memberSocketId =
        userSocketMap.get(memberId.toString()) || new Set();
      if (memberSocketId.size > 0) {
        memberSocketId.forEach((socketId) => {
          io.to(socketId).emit("new-channel-contact", result);
        });
      }
    });

    const adminSocketId = userSocketMap.get(userId.toString()) || new Set();
    if (adminSocketId.size > 0) {
      adminSocketId.forEach((socketId) => {
        io.to(socketId).emit("new-channel-contact", result);
      });
    }

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
