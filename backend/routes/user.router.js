import { Router } from "express";
import {
  updateProfile,
  deleteProfileImage,
  searchUsers,
} from "../controllers/user.controller.js";
import upload from "../utils/multerConfig.js";
import { validateToken } from "../middlewares/auth.js";

const userRouter = Router();

userRouter.patch("/:userId/profile", upload.single("image"), updateProfile);
userRouter.delete("/:userId/profile/image", deleteProfileImage);
userRouter.get("/search", validateToken, searchUsers);

export default userRouter;
