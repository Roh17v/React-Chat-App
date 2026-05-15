import mongoose from "mongoose";

const emailLogSchema = new mongoose.Schema({
  to: {
    type: String,
    required: true,
  },
  from: {
    type: String,
    required: true,
  },
  subject: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ["email_verification", "password_reset"],
    required: true,
  },
  status: {
    type: String,
    enum: ["sent", "failed"],
    required: true,
  },
  resendId: {
    type: String,
    required: false,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },
  errorMessage: {
    type: String,
    required: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const EmailLog = mongoose.model("EmailLog", emailLogSchema);
