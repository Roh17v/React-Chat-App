import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import path from "path";
import fs from "fs";
import Message from "../models/message.model.js";
import { uploadToStorage } from "../middlewares/upload.middleware.js";

export const updateProfile = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { firstName, lastName, color, profileSetup } = req.body;

    const updateData = {};

    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (color) updateData.color = JSON.parse(color);
    if (profileSetup) updateData.profileSetup = true;

    // Upload profile image to cloudflare R2
    if (req.file) {
      const imageUrl = await uploadToStorage(
        req.file,
        "profile-images"
      );
      updateData.image = imageUrl;
    }

    if (Object.keys(updateData).length === 0) {
      return next(createError(400, "No valid fields to update."));
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updatedUser) {
      return next(createError(404, "User not found"));
    }

    return res.status(200).json({
      id: updatedUser._id,
      email: updatedUser.email,
      profileSetup: updatedUser.profileSetup,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      color: updatedUser.color,
      image: updatedUser.image, // ✅ public URL
    });
  } catch (error) {
    next(error);
  }
};

export const deleteProfileImage = async (req, res, next) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) return next(createError(404, "User not found"));

    if (!user.image)
      return next(createError(400, "No profile picture to remove."));

    const imagePath = path.join(process.cwd(), user.image);
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    user.image = null;
    await user.save();

    return res
      .status(200)
      .json({ message: "Profile picture removed successfully!" });
  } catch (error) {
    next(error);
  }
};

export const searchUsers = async (req, res, next) => {
  try {
    const { q } = req.query;

    const currUserId = req.user._id;

    if (q === undefined || q === null)
      return next(createError(400, "searchTerm is required."));
    const users = await User.find({
      $and: [
        { _id: { $ne: currUserId } },
        {
          $or: [
            { firstName: { $regex: q, $options: "i" } },
            { lastName: { $regex: q, $options: "i" } },
            { email: { $regex: q, $options: "i" } },
          ],
        },
      ],
    }).select("firstName lastName email image color lastSeen");

    res.status(200).json(users);
  } catch (error) {
    next(error);
  }
};

export const dmContacts = async (req, res, next) => {
  const userId = req.user._id;

  try {
    const messages = await Message.find({
      $or: [{ sender: userId }, { receiver: userId }],
      receiver: { $ne: null },
    })
      .populate(
        "sender receiver",
        "firstName lastName email image color lastSeen _id",
      )
      .sort({ createdAt: -1 });

    const contactsMap = new Map();

    for (const msg of messages) {
      const contact =
        msg.sender._id.toString() === userId.toString()
          ? msg.receiver
          : msg.sender;

      const contactId = contact._id.toString();

      if (!contactsMap.has(contactId)) {
        contactsMap.set(contactId, { ...contact._doc, unreadCount: 0 });
      }

      if (
        msg.receiver._id.toString() === userId.toString() &&
        msg.status !== "read"
      ) {
        contactsMap.get(contactId).unreadCount += 1;
      }
    }

    res.status(200).json(Array.from(contactsMap.values()));
  } catch (error) {
    next(error);
  }
};

export const getAllContacts = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const messages = await Message.find({
      $or: [{ sender: userId }, { receiver: userId }],
      receiver: { $ne: null },
    })
      .populate("sender receiver", "firstName lastName email _id")
      .sort({ timeStamp: -1 });

    const contactMap = new Map();

    messages.forEach((msg) => {
      const contact =
        msg.sender._id.toString() === userId ? msg.receiver : msg.sender;
      contactMap.set(contact._id.toString(), contact);
    });

    const contacts = Array.from(contactMap.values());

    const allContacts = contacts.map((user) => ({
      label: user.firstName ? `${user.firstName} ${user.lastName}` : user.email,
      value: user._id,
    }));
    return res.status(200).json({ contacts: allContacts });
  } catch (error) {
    next(error);
  }
};

export const registerPushToken = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { token, platform } = req.body;

    if (!token || !platform) {
      return next(createError(400, "token and platform are required."));
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { pushTokens: { token } },
    });

    await User.findByIdAndUpdate(userId, {
      $push: { pushTokens: { token, platform, createdAt: new Date() } },
    });

    return res.status(200).json({ message: "Push token registered." });
  } catch (error) {
    next(error);
  }
};
