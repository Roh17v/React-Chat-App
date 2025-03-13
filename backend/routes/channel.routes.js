import { Router } from "express";
import { validateToken } from "../middlewares/auth.js";
import {
  createChannel,
  getUserChannels,
} from "../controllers/channel.controller.js";

const channelRouter = Router();

channelRouter.post("/", validateToken, createChannel);
channelRouter.get("/", validateToken, getUserChannels);

export default channelRouter;
