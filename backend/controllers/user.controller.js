import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import path from "path";
import fs from "fs";

export const updateProfile = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { firstName, lastName, color, profileSetup } = req.body;

    const image = req.file ? `/uploads/${req.file.filename}` : undefined;
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

