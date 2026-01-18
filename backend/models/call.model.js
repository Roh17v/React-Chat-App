import mongoose from "mongoose";

const callSchema = new mongoose.Schema(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    callerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    callType: {
      type: String,
      enum: ["audio", "video"],
      required: true,
    },
    status: {
      type: String,
      enum: ["ongoing", "missed", "rejected", "completed"],
      default: "ongoing",
      index: true,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    connectedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number, // in seconds
      default: 0,
    },
    endedBy: {
      type: String,
      enum: ["caller", "receiver", "system"],
      default: null,
    },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: false },
  }
);

/**
 * Automatically calculate duration before saving
 */
callSchema.pre("save", function (next) {
  if (this.connectedAt && this.endedAt) {
    this.duration = Math.floor(
      (this.endedAt - this.connectedAt) / 1000
    );
  }
  next();
});

const Call = mongoose.model("Call", callSchema);

export default Call;
