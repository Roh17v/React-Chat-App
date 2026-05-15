import { User, validateUser } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import bcrypt from "bcrypt";
import { Otp } from "../models/otp.model.js";
import { sendEmail } from "../services/email.service.js";
import { EmailLog } from "../models/emailLog.model.js";

export const signup = async (req, res, next) => {
  try {
    const { error } = validateUser(req.body);
    if (error) return next(createError(400, error.details[0].message));

    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      if (existingUser.isVerified) {
        return next(createError(409, "Email already registered and verified."));
      } else {
        // Delete unverified user and their OTPs to start fresh
        await User.deleteOne({ _id: existingUser._id });
        await Otp.deleteMany({ userId: existingUser._id });
      }
    }

    const newUser = new User({ email, password });
    const result = await newUser.save();

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Hash OTP
    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    // Save OTP
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await Otp.create({
      userId: result._id,
      email: result.email,
      otp: hashedOtp,
      type: "email_verification",
      expiresAt,
    });
    console.log("OTP document created in DB for:", result.email);

    // Send Email
    const emailResult = await sendEmail({
      to: result.email,
      subject: "Verify your email",
      html: `<p>Your verification code is <b>${otp}</b>. It expires in 15 minutes.</p>`,
      type: "email_verification",
      userId: result._id,
    });

    if (!emailResult.success) {
      console.error("Signup email failed to send, but user was created.");
    }

    return res.status(201).json({
      message: "Verification OTP sent to your email.",
      email: result.email,
    });
  } catch (error) {
    next(error);
  }
};

export const verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return next(createError(400, "Email and OTP are required."));
    }

    // Find the latest OTP for this email
    const otpRecord = await Otp.findOne({
      email,
      type: "email_verification",
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return next(createError(400, "Invalid or expired OTP."));
    }

    // Compare OTP
    const isValidOtp = await bcrypt.compare(otp, otpRecord.otp);
    if (!isValidOtp) {
      return next(createError(400, "Invalid or expired OTP."));
    }

    // Find user and mark as verified
    const user = await User.findOne({ email });
    if (!user) {
      return next(createError(404, "User not found."));
    }

    user.isVerified = true;
    await user.save();

    // Delete the OTP record after successful verification
    await Otp.deleteOne({ _id: otpRecord._id });

    // Generate token and set cookie (log them in)
    const token = user.generateAuthToken();
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 1000 * 60 * 60 * 24 * 2,
    });

    return res.status(200).json({
      id: user._id,
      email: user.email,
      profileSetup: user.profileSetup,
      firstName: user.firstName,
      lastName: user.lastName,
      color: user.color,
      image: user.image,
      isVerified: true,
    });
  } catch (error) {
    next(error);
  }
};

export const resendOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return next(createError(400, "Email is required."));
    }

    const user = await User.findOne({ email });
    if (!user) {
      return next(createError(404, "User not found."));
    }

    if (user.isVerified) {
      return next(createError(400, "Email is already verified."));
    }

    // Rate limiting: check if an OTP was sent in the last 60 seconds
    const lastEmailLog = await EmailLog.findOne({
      to: email,
      type: "email_verification",
      status: "sent",
    }).sort({ createdAt: -1 });

    if (lastEmailLog) {
      const timeDiff = Date.now() - new Date(lastEmailLog.createdAt).getTime();
      if (timeDiff < 60000) { // 60 seconds
        return next(createError(429, "Please wait at least 60 seconds before requesting a new OTP."));
      }
    }

    // Delete old OTPs
    await Otp.deleteMany({ userId: user._id, type: "email_verification" });

    // Generate new 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Hash OTP
    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    // Save OTP
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await Otp.create({
      userId: user._id,
      email: user.email,
      otp: hashedOtp,
      type: "email_verification",
      expiresAt,
    });

    // Send Email
    const emailResult = await sendEmail({
      to: user.email,
      subject: "Verify your email",
      html: `<p>Your verification code is <b>${otp}</b>. It expires in 15 minutes.</p>`,
      type: "email_verification",
      userId: user._id,
    });

    if (!emailResult.success) {
      console.error("Resend OTP email failed to send.");
    }

    return res.status(200).json({
      message: "Verification OTP sent to your email.",
      email: user.email,
    });
  } catch (error) {
    next(error);
  }
};

export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return next(createError(400, "Email is required."));
    }

    const user = await User.findOne({ email });
    if (!user) {
      return next(createError(404, "User not found."));
    }

    // Delete old password reset OTPs
    await Otp.deleteMany({ userId: user._id, type: "password_reset" });

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Hash OTP
    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    // Save OTP
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await Otp.create({
      userId: user._id,
      email: user.email,
      otp: hashedOtp,
      type: "password_reset",
      expiresAt,
    });

    // Send Email
    const emailResult = await sendEmail({
      to: user.email,
      subject: "Reset your password",
      html: `<p>Your password reset code is <b>${otp}</b>. It expires in 15 minutes.</p>`,
      type: "password_reset",
      userId: user._id,
    });

    if (!emailResult.success) {
      console.error("Forgot password email failed to send.");
    }

    return res.status(200).json({
      message: "Password reset OTP sent to your email.",
      email: user.email,
    });
  } catch (error) {
    next(error);
  }
};

export const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return next(createError(400, "Email, OTP, and new password are required."));
    }

    const user = await User.findOne({ email });
    if (!user) {
      return next(createError(404, "User not found."));
    }

    // Find OTP
    const otpRecord = await Otp.findOne({
      userId: user._id,
      type: "password_reset",
    });

    if (!otpRecord) {
      return next(createError(400, "Invalid or expired OTP."));
    }

    // Verify OTP
    const isValid = await bcrypt.compare(otp, otpRecord.otp);
    if (!isValid) {
      return next(createError(400, "Invalid or expired OTP."));
    }

    // Update user password (pre-save hook in user.model.js will handle hashing)
    user.password = newPassword;
    await user.save();

    // Delete OTP
    await Otp.deleteOne({ _id: otpRecord._id });

    return res.status(200).json({
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (error) {
    next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return next(createError(404, "User Not Found!"));

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword)
      return next(createError(400, "Invalid Email or Password."));

    if (!user.isVerified) {
      // Check if an OTP was already sent in the last 60 seconds
      const lastEmailLog = await EmailLog.findOne({
        to: user.email,
        type: "email_verification",
        status: "sent",
      }).sort({ createdAt: -1 });

      const recentlySent =
        lastEmailLog &&
        Date.now() - new Date(lastEmailLog.createdAt).getTime() < 60000;

      if (!recentlySent) {
        // Auto-send a fresh OTP
        await Otp.deleteMany({ userId: user._id, type: "email_verification" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const salt = await bcrypt.genSalt(10);
        const hashedOtp = await bcrypt.hash(otp, salt);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        await Otp.create({
          userId: user._id,
          email: user.email,
          otp: hashedOtp,
          type: "email_verification",
          expiresAt,
        });

        await sendEmail({
          to: user.email,
          subject: "Verify your email",
          html: `<p>Your verification code is <b>${otp}</b>. It expires in 15 minutes.</p>`,
          type: "email_verification",
          userId: user._id,
        });

        return next(
          createError(403, `A verification code has been sent to ${user.email}. Please verify your email to continue.`)
        );
      } else {
        return next(
          createError(403, `Check your email for the verification code we already sent. You can request a new one after 60 seconds.`)
        );
      }
    }

    //token generation
    const token = user.generateAuthToken();
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 1000 * 60 * 60 * 24 * 2,
    });
    return res.status(200).json({
      id: user._id,
      email: user.email,
      profileSetup: user.profileSetup,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      color: user.color,
      image: user.image,
      isVerified: true,
    });
  } catch (error) {
    next(error);
  }
};

export const sendUser = async (req, res, next) => {
  try {
    const userInfo = await User.findById(req.user._id);
    return res.status(200).json({
      id: userInfo._id,
      email: userInfo.email,
      profileSetup: userInfo.profileSetup,
      username: userInfo.username,
      firstName: userInfo.firstName,
      lastName: userInfo.lastName,
      color: userInfo.color,
      image: userInfo.image,
      isVerified: userInfo.isVerified,
    });
  } catch (error) {
    next(error); 
  }
};

export const logout = async (req, res, next) => {
  try {
    res.cookie("authToken", "", {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 1,
    });

    return res.status(200).send("Logout Successfull.");
  } catch (error) {
    next(error);
  }
};
