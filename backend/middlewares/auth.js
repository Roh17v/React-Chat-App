import { createError } from "../utils/error.js";
import jwt from "jsonwebtoken";

export async function validateToken(req, res, next) {
  const token = req.cookies.authToken;
  if (!token)
    return next(createError(401, "Access Denied.You are not Authenticated."));
  try {
    const decoded = jwt.verify(token, process.env.JWT_KEY);
    req.user = decoded;
    next();
  } catch (error) {
    next(createError(400, "Invalid Token."));
  }
}
