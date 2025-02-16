import { User, validateUser } from "../models/user.model.js";
import { createError } from "../utils/error.js";
import bcrypt from "bcrypt";

export const signup = async (req, res, next) => {
  try {
    const { error } = validateUser(req.body);
    if (error) return next(createError(400, error.details[0].message));

    const { email, password } = req.body;
    const newUser = new User({ email, password });
    const result = await newUser.save();

    //token generation
    const token = newUser.generateAuthToken();
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: true,
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
    const user = await User.findOne({ email: req.body.email });
    if (!user) return next(createError(404, "User Not Found!"));

    const { email, password } = req.body;
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword)
      return next(createError(400, "Invalid Email or Password."));

    //token generation
    const token = user.generateAuthToken();
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: true,
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
