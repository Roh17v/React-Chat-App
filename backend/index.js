import connectDB from "./src/db/index.js";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.routes.js";
import userRouter from "./routes/user.router.js";
import path from "path";
import { fileURLToPath } from "url";
import { setupSocket } from "./socket.js";
import messageRouter from "./routes/message.routes.js";
import channelRouter from "./routes/channel.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
dotenv.config();

//middlewares
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:5173",
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log("Origin:", origin); 
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.options("*", (req, res) => {
  res.sendStatus(200);
});

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/messages", messageRouter);
app.use("/api/channels", channelRouter);
app.get("/api/data", (req, res) => res.json({ message: "Secret Data" }));

//middleware to server static files
app.use(
  "/uploads/profiles",
  express.static(path.join(__dirname, "uploads", "profiles"))
);
app.use(
  "/uploads/files",
  express.static(path.join(__dirname, "uploads", "files"))
);

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
    const server = app.listen(process.env.PORT || 5000, () => {
      console.log(`Listening on PORT: ${process.env.PORT}...`);
    });

    try {
      setupSocket(server);
    } catch (error) {
      console.log("Failed to set up WebSocket: ", error);
    }
  })
  .catch((error) => {
    console.log("Failed to Connect to MongoDB...", error);
    process.exit(1);
  });
