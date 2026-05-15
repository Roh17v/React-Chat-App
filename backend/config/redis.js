import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  console.warn("⚠️ REDIS_URL is missing in .env file. Redis is disabled.");
}

const redis = redisUrl ? new Redis(redisUrl) : null;

if (redis) {
  redis.on("connect", () => {
    console.log("Connected to Redis...");
  });

  redis.on("error", (err) => {
    console.error("Redis error:", err);
  });
}

export default redis;
