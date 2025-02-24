import { Router } from "express";
import { updateProfile } from "../controllers/user.controller.js";

const userRouter = Router();

userRouter.patch("/:userId/profile", updateProfile);

export default userRouter;
