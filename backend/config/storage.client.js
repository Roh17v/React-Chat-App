import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
dotenv.config();


export const storageClient = new S3Client({
  region: "auto",
  endpoint: process.env.STORAGE_BUCKET_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
  },
});
