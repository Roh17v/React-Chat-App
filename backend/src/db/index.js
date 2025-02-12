import mongoose from "mongoose";
import { DB_NAME } from "../../constants.js";

async function connectDB() {
  try {
    const connectionInstance = await mongoose.connect(
      `${process.env.DATABASE_URI}/${DB_NAME}`
    );
    console.log(
      "Connected to DATABASE... DB_HOST: ",
      connectionInstance.connection.host
    );
  } catch (error) {
    console.log(error);
  }
}

export default connectDB;
