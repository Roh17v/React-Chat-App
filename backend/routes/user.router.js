import { Router } from "express";
import {
  updateProfile,
  deleteProfileImage,
} from "../controllers/user.controller.js";
import upload from "../utils/multerConfig.js";

const userRouter = Router();

userRouter.patch("/:userId/profile", upload.single("image"), updateProfile);
userRouter.delete("/:userId/profile/image", deleteProfileImage);

export default userRouter;
