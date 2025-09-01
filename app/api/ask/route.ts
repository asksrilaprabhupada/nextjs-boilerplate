// app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

function parseRef(q: string): null | { chapter: number; verse: number; end?: number } {
  const s = q.trim();
  let m = s.match(/\b(\d{1,2})\s*(?:[.:])\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (m) return { chapter: +m[1], verse: +m[2], end: m[3] ? +m[3] : undefined };
  m = s.match(/\b(?:bg|bhagavad(?:-|\s*)g[iī]t[āa])?(?:.*?\b)?chapter\s*(\d{1,2})\s*(?:verse|v\.?)\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i);
  if (m) return { chapter: +m[1], verse: +m[2], end: m[3] ? +m[3] : undefined };
  return null;
}

type Row = {
  work: string; chapter: number; verse: number; verse_label: string | null;
  translation: string | null; purport: string | null; rank?: number;
};

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { q, k = 8 } = await req.json();
    if (!q || typeof q !== "string") return NextResponse.json({ error: "q is required" }, { status: 400 });

    const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) return NextResponse.json({ error: "Missing Supabase envs" }, { status: 500 });

    // Fetch verses
    let rows: Row[] = [];
    const ref = parseRef(q);
    if (ref) {
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", `eq.Bhagavad-gita As It Is`);
      params.set("chapter", `eq.${ref.chapter}`);
      if (ref.end && ref.end > ref.verse) {
        params.append("verse", `gte.${ref.verse}`);
        params.append("verse", `lte.${ref.end}`);
        params.set("order", "verse.asc");
      } else {
        params.set("verse", `eq.${ref.verse}`);
      }
      const r = await fetch(`${base}?${params}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, cache: "no-store" });
      if (!r.ok) return NextResponse.json({ error: `REST ${r.status}: ${await r.text()}` }, { status: 500 });
      rows = await r.json();
    }
    if (!rows.length) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_passages_text`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ q, k: Number(k) || 8 }),
        cache: "no-store",
      });
      if (!r.ok) return NextResponse.json({ error: `RPC ${r.status}: ${await r.text()}` }, { status: 500 });
      rows = await r.json();
    }

    // If no key or no rows, return verses only
    if (!process.env.OPENAI_API_KEY || !rows.length) {
      return NextResponse.json({ answer: rows.length ? "Here are related verses." : "No passages found.", rows });
    }

    // Summarize strictly from those verses
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const context = rows.slice(0, 6).map((r, i) => {
      const label = r.verse_label || String(r.verse);
      return `#${i + 1} ${r.work} ${r.chapter}.${label}\nTranslation: ${r.translation || ""}\nPurport: ${r.purport || ""}`;
    }).join("\n\n---\n\n");

    const prompt = `Answer the question ONLY using the verses below.
- Keep it brief (3–6 sentences).
- Cite like “BG 15.1”.
Question: "${q}"\n\nVerses:\n${context}`;

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Answer using only the provided Bhagavad-gītā verses and purports." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 350,
    }); // Official Node SDK usage. :contentReference[oaicite:4]{index=4}

    const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
    return NextResponse.json({ answer, rows });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
