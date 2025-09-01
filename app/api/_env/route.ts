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
  const present = Object.fromEntries(required.map(k => [k, Boolean(process.env[k])]));
  return NextResponse.json({ present });
}
