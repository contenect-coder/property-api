require("dotenv").config();
const nodemailer = require("nodemailer");
const { Resend } = require("resend");

/**
 * Send an email using the best available configured provider.
 * Priority:
 * 1. SMTP / Gmail (Nodemailer) - if EMAIL_USER and EMAIL_PASS are set
 * 2. Resend API - if RESEND_API_KEY is set
 */
async function sendEmail({ to, subject, html, text }) {
  const emailUser = process.env.EMAIL_USER || process.env.SMTP_USER;
  const emailPass = process.env.EMAIL_PASS || process.env.SMTP_PASS;
  const resendApiKey = process.env.RESEND_API_KEY;

  // 1. Check if SMTP / Gmail is configured
  if (emailUser && emailPass) {
    try {
      const transporter = nodemailer.createTransport({
        service: process.env.SMTP_SERVICE || "gmail",
        host: process.env.SMTP_HOST || undefined,
        port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : undefined,
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: emailUser,
          pass: emailPass.replace(/\s+/g, ""), // strip spaces if copied with spaces
        },
      });

      const info = await transporter.sendMail({
        from: `"${process.env.EMAIL_FROM_NAME || "HOME Real Estate"}" <${emailUser}>`,
        to,
        subject,
        html,
        text,
      });

      console.log(`[Mailer] Email sent via SMTP to ${to} (Message ID: ${info.messageId})`);
      return { success: true, provider: "smtp", messageId: info.messageId };
    } catch (err) {
      console.error("[Mailer] SMTP send failed:", err.message);
      return { success: false, provider: "smtp", error: err.message };
    }
  }

  // 2. Fallback to Resend
  if (resendApiKey) {
    try {
      const resend = new Resend(resendApiKey);
      const fromAddress = process.env.RESEND_FROM || "onboarding@resend.dev";
      const { data, error } = await resend.emails.send({
        from: fromAddress,
        to,
        subject,
        html,
        text,
      });

      if (error) {
        console.error(`[Mailer] Resend error sending to ${to}:`, error.message || error);
        return {
          success: false,
          provider: "resend",
          error: error.message || JSON.stringify(error),
          statusCode: error.statusCode,
        };
      }

      console.log(`[Mailer] Email sent via Resend to ${to} (ID: ${data?.id})`);
      return { success: true, provider: "resend", messageId: data?.id };
    } catch (err) {
      console.error("[Mailer] Resend unexpected error:", err.message);
      return { success: false, provider: "resend", error: err.message };
    }
  }

  console.warn("[Mailer] No email provider configured (missing EMAIL_USER/EMAIL_PASS and RESEND_API_KEY).");
  return {
    success: false,
    provider: "none",
    error: "No email provider configured in server environment.",
  };
}

module.exports = { sendEmail };
