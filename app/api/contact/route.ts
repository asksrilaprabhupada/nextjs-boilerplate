// app/api/contact/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sendMail } from "../../../lib/mailer";
import { appendRow } from "../../../lib/sheets";
import dayjs from "dayjs";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  subject: z.string().min(3),
  message: z.string().min(5),
});

export async function POST(req: NextRequest) {
  try {
    const { name, email, subject, message } = schema.parse(await req.json());

    // Send to you (your email never exposed in UI)
    await sendMail({
      to: process.env.ADMIN_EMAIL!,
      subject: `Contact: ${subject}`,
      html: `<p><strong>From:</strong> ${name} &lt;${email}&gt;</p>
             <p><strong>Subject:</strong> ${subject}</p>
             <p><strong>Message:</strong><br/>${message.replace(/\n/g, "<br/>")}</p>`,
      replyTo: email,
    });

    // Optional log to a contact sheet (if set)
    if (process.env.GOOGLE_SHEETS_CONTACT_ID) {
      await appendRow({
        spreadsheetId: process.env.GOOGLE_SHEETS_CONTACT_ID!,
        values: [dayjs().toISOString(), name, email, subject, message, "contact-form"],
      });
    }

    // Auto-ack to the sender
    await sendMail({
      to: email,
      subject: "We received your message — Ask Śrīla Prabhupāda",
      html: `<p>Hare Kṛṣṇa ${name},</p><p>Thank you for contacting us. We’ll reply soon.</p>`,
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("CONTACT_FORM_ERROR", e?.message || e);
    return NextResponse.json(
      { error: "Invalid or failed submission" },
      { status: 400 }
    );
  }
}
