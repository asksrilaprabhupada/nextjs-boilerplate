import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { q, k = 5 } = await req.json();
    const query = (q ?? "").toString().trim();
    const limit = Math.min(Number(k) || 5, 20);

    if (!query) {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    // Call the Supabase RPC that does full-text search (no OpenAI)
    const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/search_passages_text`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, k: limit }),
      cache: "no-store",
    });

    if (!r.ok) {
      const text = await r.text();
      return NextResponse.json({ error: `RPC ${r.status}: ${text}` }, { status: 500 });
    }

    const rows = await r.json();
    return NextResponse.json({ rows });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
