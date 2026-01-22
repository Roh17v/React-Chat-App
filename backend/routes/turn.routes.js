import express from "express";
import { validateToken } from "../middlewares/auth.js";
import { getTurnCredentials } from "../controllers/turn.controller.js";

const router = express.Router();

router.get("/credentials", validateToken, getTurnCredentials);

export default router;
