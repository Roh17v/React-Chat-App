import connectDB from "./src/db/index.js";
import dotenv from "dotenv";
import express from "express";
import cors from 'cors';
import cookieParser from "cookie-parser";
import authRouter from './routes/auth.routes.js';

const app = express();
dotenv.config();

//middlewares
app.use(
    cors({
    origin: [process.env.ORIGIN],
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
    })
);
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authRouter);


//Error Handler
app.use((err, req, res, next) => {
  const errorStatus = err.status || 500;
  const errorMessage = err.message || "Something Went Wrong!";
  if (err)
    return res.status(errorStatus).json({
      success: false,
      status: errorStatus,
      message: errorMessage,
      stack: err.stack,
    });
  next();
});

connectDB()
  .then(() => {
    app.listen(process.env.PORT || 5000, () => {
      console.log(`Listening on PORT: ${process.env.PORT}...`);
    });
  })
  .catch((error) => {
    console.log("Failed to Connect to MongoDB...", error);
    process.exit(1);
  });
