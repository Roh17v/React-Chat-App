import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";

export const updateProfile = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { firstName, lastName, image, color, profileSetup } = req.body;

    const updateData = {};

    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (image !== undefined) updateData.image = image;
    if (color) updateData.color = color;
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
    return res.status(200).json(updatedUser);
  } catch (error) {
    next(error);
  }
};
