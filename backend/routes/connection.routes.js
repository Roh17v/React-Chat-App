import { Router } from "express";
import { sendRequest, respondRequest, getPendingRequests } from "../controllers/connection.controller.js";
import { validateToken } from "../middlewares/auth.js";

const router = Router();

router.post("/request", validateToken, sendRequest);
router.put("/respond", validateToken, respondRequest);
router.get("/pending", validateToken, getPendingRequests);

export default router;
