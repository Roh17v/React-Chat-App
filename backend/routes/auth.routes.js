import Router from "express";
import {
  login,
  logout,
  sendUser,
  signup,
  verifyEmail,
  resendOtp,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controller.js";
import { validateToken } from "../middlewares/auth.js";

const router = Router();

router.post("/signup", signup);

router.post("/verify-email", verifyEmail);

router.post("/resend-otp", resendOtp);

router.post("/forgot-password", forgotPassword);

router.post("/reset-password", resetPassword);

router.post("/login", login);

router.get("/me", validateToken, sendUser);

router.post("/logout", logout);

export default router;
