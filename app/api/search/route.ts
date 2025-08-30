import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(req: NextRequest) {
  try {
    const { q, k = 5 } = await req.json();
    if (!q || typeof q !== "string") {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    const emb = await openai.embeddings.create({ model, input: q });
    const vec = emb.data[0].embedding;
    const p_emb = `[${vec.join(",")}]`; // pgvector literal string

    const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/search_passages`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_emb, p_limit: Number(k) || 5 })
    });

    if (!r.ok) {
      const text = await r.text();
      return NextResponse.json({ error: `RPC ${r.status}: ${text}` }, { status: 500 });
    }

    const rows = (await r.json()) as any[];
    return NextResponse.json({ rows });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "unknown error" }, { status: 500 });
  }
}
