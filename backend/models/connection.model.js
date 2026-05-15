import mongoose from "mongoose";

const connectionSchema = new mongoose.Schema({
  requester_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  receiver_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected", "blocked", "cancelled"],
    default: "pending",
  },
  accepted_at: {
    type: Date,
  },
  blocked_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
}, { timestamps: true });

// Prevent duplicate requests between the same two users in the same direction
connectionSchema.index({ requester_id: 1, receiver_id: 1 }, { unique: true });

export const Connection = mongoose.model("Connection", connectionSchema);
