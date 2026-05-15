import { Connection } from "../models/connection.model.js";
import { User } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import redis from "../config/redis.js";
import { addContactToActiveSockets } from "../socket.js";

// Send a connection request
export const sendRequest = async (req, res, next) => {
  try {
    const { receiverId } = req.body;
    const requesterId = req.user._id;

    if (requesterId.toString() === receiverId) {
      return next(createError(400, "You cannot send a connection request to yourself."));
    }

    const receiver = await User.findById(receiverId);
    if (!receiver) return next(createError(404, "User not found."));

    // Check if a request or connection already exists in EITHER direction
    const existingConnection = await Connection.findOne({
      $or: [
        { requester_id: requesterId, receiver_id: receiverId },
        { requester_id: receiverId, receiver_id: requesterId }
      ]
    });

    if (existingConnection) {
      if (existingConnection.status === "pending" || existingConnection.status === "accepted") {
        return next(createError(400, "A connection request or active connection already exists."));
      }
      
      // If the previous request was rejected, reset it to pending and update direction
      if (existingConnection.status === "rejected") {
        existingConnection.status = "pending";
        existingConnection.requester_id = requesterId;
        existingConnection.receiver_id = receiverId;
        await existingConnection.save();
        
        return res.status(201).json({ 
          message: "Connection request sent again.",
          requestId: existingConnection._id
        });
      }
    }

    const connection = new Connection({
      requester_id: requesterId,
      receiver_id: receiverId,
      status: "pending"
    });

    await connection.save();

    return res.status(201).json({ 
      message: "Connection request sent successfully.",
      requestId: connection._id
    });
  } catch (error) {
    next(error);
  }
};

// Accept or Reject a request
export const respondRequest = async (req, res, next) => {
  try {
    const { requestId, status } = req.body; // status: 'accepted' or 'rejected'
    const userId = req.user._id;

    if (!["accepted", "rejected"].includes(status)) {
      return next(createError(400, "Invalid status."));
    }

    const connection = await Connection.findById(requestId);
    if (!connection) return next(createError(404, "Request not found."));

    // Verify that the current user is the receiver of the request
    if (connection.receiver_id.toString() !== userId.toString()) {
      return next(createError(403, "You are not authorized to respond to this request."));
    }

    if (connection.status !== "pending") {
      return next(createError(400, "This request has already been processed."));
    }

    connection.status = status;
    if (status === "accepted") {
      connection.accepted_at = new Date();
      
      // Add to contacts array for both users to maintain the friends list!
      await User.findByIdAndUpdate(connection.requester_id, { $addToSet: { contacts: connection.receiver_id } });
      await User.findByIdAndUpdate(connection.receiver_id, { $addToSet: { contacts: connection.requester_id } });
      
      // Add to Redis for fast socket checks!
      if (redis) {
        await redis.sadd(`user:${connection.requester_id}:contacts`, connection.receiver_id.toString());
        await redis.sadd(`user:${connection.receiver_id}:contacts`, connection.requester_id.toString());
        await redis.del(`user:${connection.requester_id}:sidebar`);
        await redis.del(`user:${connection.receiver_id}:sidebar`);
        console.log(`[Redis] Invalidated sidebar cache for ${connection.requester_id} and ${connection.receiver_id}`);
      }
      
      // Update in-memory cache for active sockets!
      addContactToActiveSockets(connection.requester_id.toString(), connection.receiver_id.toString());
      addContactToActiveSockets(connection.receiver_id.toString(), connection.requester_id.toString());
    }

    await connection.save();

    return res.status(200).json({ message: `Request ${status} successfully.` });
  } catch (error) {
    next(error);
  }
};

// Get all pending requests received by the current user
export const getPendingRequests = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const requests = await Connection.find({
      receiver_id: userId,
      status: "pending"
    }).populate("requester_id", "firstName lastName email username image color");

    return res.status(200).json(requests);
  } catch (error) {
    next(error);
  }
};
