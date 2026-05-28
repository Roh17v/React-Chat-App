import { createError } from "../utils/error.js";
import jwt from "jsonwebtoken";

export async function validateToken(req, res, next) {
  let token = req.cookies.authToken;

  // Fallback to Authorization header if cookie is missing (for Capacitor native mobile clients)
  if (!token && req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token)
    return next(createError(401, "Access Denied. You are not Authenticated."));
  try {
    const decoded = jwt.verify(token, process.env.JWT_KEY);
    req.user = decoded;
    next();
  } catch (error) {
    next(createError(400, "Invalid Token."));
  }
}
