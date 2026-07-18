import { Router } from "express";
import {
  updateProfile,
  deleteProfileImage,
  searchUsers,
  dmContacts,
  getAllContacts,
  registerPushToken,
  getContactsUpdates
} from "../controllers/user.controller.js";
import { validateToken } from "../middlewares/auth.js";
import upload from "../middlewares/upload.middleware.js";

const userRouter = Router();

userRouter.patch("/:userId/profile", upload.single("image"), updateProfile);
userRouter.delete("/:userId/profile/image", deleteProfileImage);
userRouter.get("/search", validateToken, searchUsers);
userRouter.get("/dm-contacts", validateToken, dmContacts);
userRouter.get("/contacts", validateToken, getAllContacts);
userRouter.post("/push-token", validateToken, registerPushToken);
userRouter.get("/updates", validateToken, getContactsUpdates);

export default userRouter;
