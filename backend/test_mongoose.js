import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import Message from "./models/message.model.js";

async function run() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const senderId = new mongoose.Types.ObjectId();
  const receiverId = new mongoose.Types.ObjectId();

  const msg = await Message.create({
    sender: senderId,
    receiver: receiverId,
    messageType: "text",
    content: "hello",
    status: "sent"
  });

  console.log("Before:", msg.updatedAt);
  
  // wait 1 second
  await new Promise(r => setTimeout(r, 1000));

  await Message.updateMany(
    { _id: msg._id },
    { $set: { status: "delivered" } }
  );

  const updatedMsg = await Message.findById(msg._id);
  console.log("After:", updatedMsg.updatedAt);
  console.log("Are equal?", msg.updatedAt.getTime() === updatedMsg.updatedAt.getTime());

  await mongoose.disconnect();
  await mongod.stop();
}

run();
