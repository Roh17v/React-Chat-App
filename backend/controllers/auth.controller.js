import { User, validateUser } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import bcrypt from "bcrypt";

export const signup = async (req, res, next) => {
  try {
    const { error } = validateUser(req.body);
    if (error) return next(createError(400, error.details[0].message));

    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return next(createError(409, "Email already registered."));
    }

    const newUser = new User({ email, password });
    const result = await newUser.save();

    //token generation
    const token = newUser.generateAuthToken();
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 3600000,
    });

    return res.status(201).json({
      id: result._id,
      email: result.email,
      profileSetup: result.profileSetup,
    });
  } catch (error) {
    next(error);
  }
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return next(createError(404, "User Not Found!"));

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword)
      return next(createError(400, "Invalid Email or Password."));

    //token generation
    const token = user.generateAuthToken();
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 3600000,
    });
    return res.status(200).json({
      id: user._id,
      email: user.email,
      profileSetup: user.profileSetup,
      firstName: user.firstName,
      lastName: user.lastName,
      color: user.color,
      image: user.image,
    });
  } catch (error) {
    next(error);
  }
};

export const sendUser = async (req, res, next) => {
  try {
    const userInfo = await User.findById(req.user._id);
    return res.status(200).json({
      id: userInfo._id,
      email: userInfo.email,
      profileSetup: userInfo.profileSetup,
      firstName: userInfo.firstName,
      lastName: userInfo.lastName,
      color: userInfo.color,
      image: userInfo.image,
    });
  } catch (error) {
    next(error); 
  }
};

export const logout = async (req, res, next) => {
  try {
    res.cookie("authToken", "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 1,
    });

    return res.status(200).send("Logout Successfull.");
  } catch (error) {
    next(error);
  }
};
