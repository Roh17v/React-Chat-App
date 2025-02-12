import connectDB from "./src/db/index.js";
import dotenv from "dotenv";
import express from "express";
import cors from 'cors';
import cookieParser from "cookie-parser";

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
