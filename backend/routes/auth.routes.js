import Router from "express";
import { login, sendUser, signup } from "../controllers/auth.controller.js";
import { validateToken } from "../middlewares/auth.js";

const router = Router();

router.post("/signup", signup);

router.post("/login", login);

router.get("/me", validateToken, sendUser);

export default router;
