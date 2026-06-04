import { Router } from "express";
import {
  getChannelMessages,
  getMessages,
  uploadFile,
  deleteForMe,
  deleteForEveryone,
  getUnifiedUpdates,
} from "../controllers/message.controller.js";
import { validateToken } from "../middlewares/auth.js";
import upload from "../middlewares/upload.middleware.js";
import { ensureUsersCanCommunicate } from "../middlewares/permission.js";

const messageRouter = Router();

// Unified incremental-sync feed — must be registered BEFORE the
// parameterised `:contactId` route so Express does not swallow
// the literal segment "updates" as a contact id.
messageRouter.get("/updates", validateToken, getUnifiedUpdates);
messageRouter.get("/private/:contactId", validateToken, ensureUsersCanCommunicate, getMessages);
messageRouter.get("/channel/:channelId", validateToken, getChannelMessages);

messageRouter.post(
  "/upload-file",
  validateToken,
  ensureUsersCanCommunicate,
  upload.single("file"),
  uploadFile
);
messageRouter.patch("/:messageId/delete-for-me", validateToken, deleteForMe);
messageRouter.patch(
  "/:messageId/delete-for-everyone",
  validateToken,
  deleteForEveryone
);

export default messageRouter;
