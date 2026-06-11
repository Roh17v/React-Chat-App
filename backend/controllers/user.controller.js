import { User } from "../models/user.model.js";
import { Connection } from "../models/connection.model.js";
import { createError } from "../utils/error.js";
import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import Message from "../models/message.model.js";
import { uploadToStorage } from "../middlewares/upload.middleware.js";
import { io, userSocketMap } from "../socket.js";

const getFileNameFromUrl = (url) => {
  if (!url) return "File";
  try {
    const parsedUrl = new URL(url);
    const fileName = parsedUrl.pathname.split("/").pop();
    return decodeURIComponent(fileName || "File");
  } catch {
    const fileName = url.split("/").pop();
    return decodeURIComponent(fileName || "File");
  }
};

const getMessagePreview = (message) => {
  if (!message) return "No messages yet";

  if (message.messageType === "text") {
    const trimmed = (message.content || "").trim();
    return trimmed || "Message";
  }

  if (message.messageType === "file") {
    return `Attachment: ${message.fileName || getFileNameFromUrl(message.fileUrl)}`;
  }

  if (message.messageType === "call") {
    return "Call";
  }

  return "Message";
};

export const updateProfile = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { firstName, lastName, color, profileSetup, username } = req.body;

    const user = await User.findById(userId);
    if (!user) return next(createError(404, "User not found"));

    const updateData = {};

    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (color) updateData.color = JSON.parse(color);

    if (username) {
      // Check if username is already taken by another user
      const existingUser = await User.findOne({
        username: username.toLowerCase(),
        _id: { $ne: userId },
      });
      if (existingUser) {
        return next(createError(409, "Username is already taken."));
      }
      updateData.username = username.toLowerCase();
    }

    if (profileSetup) {
      // Enforce username during profile setup
      if (!username && !user.username) {
        return next(
          createError(400, "Username is required to complete profile setup."),
        );
      }
      updateData.profileSetup = true;
    }

    // Upload profile image to cloudflare R2
    if (req.file) {
      const imageUrl = await uploadToStorage(req.file, "profile-images");
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
      },
    );

    // Invalidate sidebar caches and notify contacts!
    try {
      const userWithContacts = await User.findById(userId).select("contacts");
      const contacts = userWithContacts?.contacts || [];

      
      // Emit socket event to all contacts!
      contacts.forEach((contactId) => {
        const sockets = userSocketMap.get(contactId.toString()) || new Set();
        sockets.forEach((socketId) => {
          io.to(socketId).emit("user-profile-updated", {
            userId: updatedUser._id,
            firstName: updatedUser.firstName,
            lastName: updatedUser.lastName,
            image: updatedUser.image,
            color: updatedUser.color,
          });
        });
      });
    } catch (err) {
      console.error("Error in profile update cache invalidation/notification:", err);
    }

    return res.status(200).json({
      id: updatedUser._id,
      email: updatedUser.email,
      username: updatedUser.username,
      profileSetup: updatedUser.profileSetup,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      color: updatedUser.color,
      image: updatedUser.image, // ✅ public URL
      isVerified: updatedUser.isVerified,
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

    // Use standard query for exact match on email or username (or partial match if you prefer)
    // For privacy and correctness, we will use exact match for email/username as you requested.
    const users = await User.find({
      _id: { $ne: currUserId },
      $or: [{ email: q }, { username: q }],
    })
      .select("firstName lastName email username image color lastSeen")
      .limit(20)
      .lean();

    // Fetch connections for these users to determine relationship status
    const userIds = users.map((u) => u._id);
    const connections = await Connection.find({
      $or: [
        { requester_id: currUserId, receiver_id: { $in: userIds } },
        { requester_id: { $in: userIds }, receiver_id: currUserId },
      ],
    });

    // Map connection status to users
    const usersWithStatus = users.map((u) => {
      const conn = connections.find(
        (c) =>
          (c.requester_id.toString() === currUserId.toString() &&
            c.receiver_id.toString() === u._id.toString()) ||
          (c.requester_id.toString() === u._id.toString() &&
            c.receiver_id.toString() === currUserId.toString()),
      );

      return {
        ...u,
        connectionStatus: conn ? conn.status : "none",
        isRequester: conn
          ? conn.requester_id.toString() === currUserId.toString()
          : false,
        requestId: conn ? conn._id : null,
      };
    });

    res.status(200).json(usersWithStatus);
  } catch (error) {
    next(error);
  }
};

export const dmContacts = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const userIdObj = new mongoose.Types.ObjectId(userId);

    const aggregatedMessages = await Message.aggregate([
      {
        $match: {
          $or: [{ sender: userIdObj }, { receiver: userIdObj }],
          receiver: { $ne: null },
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$sender", userIdObj] },
              "$receiver",
              "$sender"
            ]
          },
          lastMessageDoc: { $first: "$$ROOT" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$receiver", userIdObj] },
                    { $ne: ["$status", "read"] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "contactInfo"
        }
      },
      {
        $unwind: "$contactInfo"
      }
    ]);

    const contactsMap = new Map();

    for (const agg of aggregatedMessages) {
      if (!agg.lastMessageDoc.sender || !agg.lastMessageDoc.receiver) continue;

      const contact = agg.contactInfo;
      const contactId = contact._id.toString();

      contactsMap.set(contactId, {
        _id: contact._id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        image: contact.image,
        color: contact.color,
        lastSeen: contact.lastSeen,
        unreadCount: agg.unreadCount,
        lastMessage: getMessagePreview(agg.lastMessageDoc),
        lastMessageAt: agg.lastMessageDoc.createdAt || null,
      });
    }

    // Fetch the user's contacts array to include friends with no messages yet
    const currentUser = await User.findById(userId).populate(
      "contacts",
      "firstName lastName email image color lastSeen _id",
    );

    if (currentUser && currentUser.contacts) {
      for (const friend of currentUser.contacts) {
        if (!friend) continue; // Skip if user was deleted

        const friendId = friend._id.toString();

        if (!contactsMap.has(friendId)) {
          contactsMap.set(friendId, {
            ...friend._doc,
            unreadCount: 0,
            lastMessage: "No messages yet",
            lastMessageAt: friend.createdAt || new Date(),
          });
        }
      }
    }

    const sidebarData = Array.from(contactsMap.values());

    sidebarData.sort((a, b) => {
      const dateA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const dateB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return dateB - dateA;
    });

    res.status(200).json(sidebarData);
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
