import { Router } from "express";
import { validateToken } from "../middlewares/auth.js";
import { finalizeCall } from "../controllers/call.controller.js";
import { ensureUsersCanCommunicate } from "../middlewares/permission.js";

const callRouter = Router();

callRouter.post("/finalize", validateToken, ensureUsersCanCommunicate, finalizeCall);

export default callRouter;

