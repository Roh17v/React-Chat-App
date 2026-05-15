import { Connection } from "../models/connection.model.js";
import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";

export const ensureUsersCanCommunicate = async (req, res, next) => {
  try {
    const userId = req.user._id;
    
    // Extract target user ID from body, params, or query
    const targetId = req.body.receiverId || req.params.receiverId || req.query.receiverId || req.params.contactId;

    // If no target ID is involved in this request, skip the check
    if (!targetId) {
      return next();
    }

    // Users can always communicate with themselves
    if (userId.toString() === targetId.toString()) {
      return next();
    }

    // Check if an accepted connection exists in EITHER direction
    const connection = await Connection.findOne({
      $or: [
        { requester_id: userId, receiver_id: targetId },
        { requester_id: targetId, receiver_id: userId }
      ],
      status: "accepted"
    });

    if (!connection) {
      // Fallback for old users: Check if they are in each other's contacts array!
      const user = await User.findById(userId).select("contacts");
      const isFriend = user?.contacts?.map(c => c.toString()).includes(targetId.toString());
      
      if (!isFriend) {
        return next(
          createError(403, "Access denied. You must be connected with this user to interact.")
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};
