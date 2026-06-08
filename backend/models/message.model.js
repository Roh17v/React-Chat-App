import mongoose, { mongo } from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    messageType: {
      type: String,
      enum: ["text", "file", "call"],
      required: true,
    },
    content: {
      type: String,
      required: function () {
        return this.messageType === "text";
      },
    },
    callId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Call",
      default: null,
    },
    fileUrl: {
      type: String,
      required: function () {
        return this.messageType === "file";
      },
    },
    fileName: {
      type: String,
      default: null,
    },
    fileMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Channel",
      default: null,
    },
    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
    },
    replyTo: {
      messageId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Message",
        default: null,
      },
      senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      messageType: {
        type: String,
        enum: ["text", "file"],
        default: null,
      },
      previewText: {
        type: String,
        default: null,
      },
      fileName: {
        type: String,
        default: null,
      },
      createdAt: {
        type: Date,
        default: null,
      },
    },
    deletedFor: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }],
    deletedForEveryone: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Performance Indexes
messageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
messageSchema.index({ receiver: 1, sender: 1, createdAt: -1 });
messageSchema.index({ channelId: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ receiver: 1, status: 1 });
// Supports the unified incremental-sync feed (GET /api/messages/updates).
// The $or branches for unified sync use updatedAt > since + sort ASC,
// which benefits from an ascending cursor index on updatedAt.
messageSchema.index({ receiver: 1, updatedAt: 1 });
messageSchema.index({ sender: 1, updatedAt: 1 });
messageSchema.index({ channelId: 1, updatedAt: 1 });


const Message = mongoose.model("Message", messageSchema);

export default Message;
