import { NextRequest, NextResponse } from "next/server";
import { appendRow } from "@/lib/sheets";
import { sendMail } from "@/lib/mailer";
import dayjs from "dayjs";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  country: z.string().min(1),
  feature: z.string().min(5),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const { name, email, country, feature } = parsed.data;

  try {
    await appendRow({
      spreadsheetId: process.env.GOOGLE_SHEETS_FEATURE_ID!,
      values: [dayjs().toISOString(), name, email, country, feature, "feature-form"],
    });

    await sendMail({
      to: email,
      subject: "We received your feature suggestion — Ask Śrīla Prabhupāda",
      html: `<p>Hare Kṛṣṇa ${name},</p>
             <p>Thank you for your suggestion. Here is a copy:</p>
             <hr/>
             <p><strong>Country:</strong> ${country}</p>
             <p><strong>Feature:</strong><br/>${feature.replace(/\n/g, "<br/>")}</p>`,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("FEATURE_FORM_ERROR", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
