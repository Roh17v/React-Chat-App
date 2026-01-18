import multer from "multer";
import crypto from "crypto";
import { Readable } from "stream";
import { Upload } from "@aws-sdk/lib-storage";
import { storageClient } from "../config/storage.client.js";

// Multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

export default upload;

/**
 * Upload a file buffer to object storage
 */
export const uploadToStorage = async (file, folder = "uploads") => {
  if (!file || !file.buffer) {
    throw new Error("INVALID_FILE");
  }

  try {
    const ext = file.originalname.split(".").pop();
    const key = `${folder}/${crypto.randomUUID()}.${ext}`;

    // Convert buffer → readable stream
    const stream = Readable.from(file.buffer);

    const uploader = new Upload({
      client: storageClient,
      params: {
        Bucket: process.env.STORAGE_BUCKET_NAME,
        Key: key,
        Body: stream,
        ContentType: file.mimetype,
        ContentLength: file.buffer.length,
      },
    });

    await uploader.done();

    return `${process.env.STORAGE_PUBLIC_URL}/${key}`;
  } catch (error) {
    console.error("Storage upload failed:", error);
    throw new Error("FILE_UPLOAD_FAILED");
  }
};
