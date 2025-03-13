import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import path from "path";
import fs from "fs";
import Message from "../models/message.model.js";

export const updateProfile = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { firstName, lastName, color, profileSetup } = req.body;

    const image = req.file
      ? `/uploads/profiles/${req.file.filename}`
      : undefined;
    const updateData = {};

    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (image !== undefined) updateData.image = image;
    if (color) updateData.color = JSON.parse(color);
    if (profileSetup) updateData.profileSetup = true;

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

    if (!updatedUser) return next(createError(400, "User Not Found!"));
    return res.status(200).json({
      id: updatedUser._id,
      email: updatedUser.email,
      profileSetup: updatedUser.profileSetup,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      color: updatedUser.color,
      image: updatedUser.image,
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
    }).select("firstName lastName email image color");

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
      .populate("sender receiver", "firstName lastName email image color _id")
      .sort({ timeStamp: -1 });

    const contactsMap = new Map();

    messages.forEach((msg) => {
      const contact =
        msg.sender._id.toString() === userId.toString()
          ? msg.receiver
          : msg.sender;
      contactsMap.set(contact._id.toString(), contact);
    });

    const contacts = Array.from(contactsMap.values());

    res.status(200).json(contacts);
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
