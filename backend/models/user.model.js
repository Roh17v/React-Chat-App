import { genSalt, hash } from "bcrypt";
import mongoose from "mongoose";
import Joi from "joi";
import jwt from "jsonwebtoken";

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, "Email is required."],
    unique: true,
  },
  username: {
    type: String,
    required: false,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, "Password is required."],
  },
  firstName: {
    type: String,
    required: false,
  },
  lastName: {
    type: String,
    required: false,
  },
  image: {
    type: String,
    required: false,
  },
  color: {
    type: Object,
    required: false,
  },
  profileSetup: {
    type: Boolean,
    default: false,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  lastSeen: {
    type: Date,
    default: null,
  },
  contacts: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  channels: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Channel",
    },
  ],
  pushTokens: [
    {
      token: {
        type: String,
        required: true,
      },
      platform: {
        type: String,
        enum: ["web", "android"],
        required: true,
      },
      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
  ],
}, { timestamps: true });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await genSalt(10);
  this.password = await hash(this.password, salt);
  next();
});

userSchema.methods.generateAuthToken = function () {
  const token = jwt.sign(
    { _id: this._id, email: this.email },
    process.env.JWT_KEY,
    { expiresIn: "7 days" }
  );
  return token;
};

export const validateUser = (user) => {
  const schema = Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required().min(5).max(1024),
    username: Joi.string().optional().min(3).max(30).alphanum().lowercase(),
    firstName: Joi.string().optional(),
    lastName: Joi.string().optional(),
    image: Joi.string().optional(),
    color: Joi.string().optional(),
    profileSetup: Joi.boolean().optional(),
  });

  return schema.validate(user);
};

// Text index for robust and scalable full-text searching
userSchema.index({ firstName: "text", lastName: "text", email: "text", username: "text" });

export const User = mongoose.model("User", userSchema);
