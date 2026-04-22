import { Router } from "express";
import { validateToken } from "../middlewares/auth.js";
import { finalizeCall } from "../controllers/call.controller.js";

const callRouter = Router();

callRouter.post("/finalize", validateToken, finalizeCall);

export default callRouter;

