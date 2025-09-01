// lib/mailer.ts
import nodemailer from "nodemailer";

export const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER!,
    pass: process.env.GMAIL_APP_PASSWORD!,
  },
});

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}) {
  await mailer.sendMail({
    from: `"Ask Śrīla Prabhupāda" <no-reply@asksp.app>`,
    to: opts.to,
    replyTo: opts.replyTo ?? process.env.ADMIN_EMAIL,
    subject: opts.subject,
    html: opts.html,
  });
}
