import { Router } from "express";
import { getMessages } from "../controllers/message.controller.js";
import { validateToken } from "../middlewares/auth.js";

const messageRouter = Router();

messageRouter.get("/:contactId", validateToken, getMessages);

export default messageRouter;
