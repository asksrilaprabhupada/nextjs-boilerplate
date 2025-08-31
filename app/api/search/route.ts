import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { q, k = 5 } = await req.json();
    if (!q || typeof q !== "string") {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json(
        { error: "Missing env", details: { SUPABASE_URL: !!SUPABASE_URL, SERVICE_KEY: !!SERVICE_KEY } },
        { status: 500 }
      );
    }

    // 🔁 call the function that exists in your DB
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_passages_fts`;

    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      // 🔁 send the param names the function expects (q, k)
      body: JSON.stringify({ q, k: Number(k) || 5 }),
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
