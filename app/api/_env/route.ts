// app/api/_env/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

export async function GET() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GOOGLE_SA_EMAIL",
    "GOOGLE_SA_PRIVATE_KEY",
    "GOOGLE_SHEETS_FEATURE_ID",
    "ADMIN_EMAIL",
    "GMAIL_USER",
    "GMAIL_APP_PASSWORD",
  ];

  const present = Object.fromEntries(required.map((k) => [k, Boolean(process.env[k])]));

  return NextResponse.json({
    // quick self-check flags
    openai: !!process.env.OPENAI_API_KEY,
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_service_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,

    // your extended checklist
    present,
  });
}
