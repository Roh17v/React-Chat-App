import { Router } from "express";
import {
  getChannelMessages,
  getMessages,
  uploadFile,
} from "../controllers/message.controller.js";
import { validateToken } from "../middlewares/auth.js";
import upload from "../middlewares/upload.middleware.js";

const messageRouter = Router();

messageRouter.get("/private/:contactId", validateToken, getMessages);
messageRouter.get("/channel/:channelId", validateToken, getChannelMessages);
messageRouter.post(
  "/upload-file",
  validateToken,
  upload.single("file"),
  uploadFile
);

export default messageRouter;
