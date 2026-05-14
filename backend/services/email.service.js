import { Resend } from "resend";
import { EmailLog } from "../models/emailLog.model.js";

export const sendEmail = async ({ to, subject, html, type, userId = null }) => {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  
  try {
    const data = await resend.emails.send({
      from,
      to,
      subject,
      html,
    });

    // Log success
    await EmailLog.create({
      to,
      from,
      subject,
      type,
      status: "sent",
      resendId: data.id,
      userId,
    });
    console.log("Email log created (success) for:", to);

    return { success: true, id: data.id };
  } catch (error) {
    // Log failure
    await EmailLog.create({
      to,
      from,
      subject,
      type,
      status: "failed",
      errorMessage: error.message,
      userId,
    });
    console.log("Email log created (failed) for:", to);

    console.error("Failed to send email:", error);
    return { success: false, error: error.message };
  }
};
