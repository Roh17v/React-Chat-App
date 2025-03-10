import { Router } from "express";
import { getMessages, uploadFile } from "../controllers/message.controller.js";
import { validateToken } from "../middlewares/auth.js";
import multer from "multer";

const messageRouter = Router();
const upload = multer({ dest: "uploads/files" });

messageRouter.get("/:contactId", validateToken, getMessages);
messageRouter.post(
  "/upload-file",
  validateToken,
  upload.single("file"),
  uploadFile
);

export default messageRouter;
