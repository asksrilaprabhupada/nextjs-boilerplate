// app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/** Parse verse refs like "BG 15.1", "13:6-7", "chapter 2 verse 20" */
function parseRef(q: string): null | { chapter: number; verse: number; end?: number } {
  const s = q.trim();
  // 1) 13.6-7 or 10:21-25 or 15.1
  let m = s.match(/\b(\d{1,2})\s*(?:[.:])\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (m) {
    const chapter = parseInt(m[1], 10);
    const verse = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : undefined;
    return { chapter, verse, end };
  }
  // 2) optional "BG/Bhagavad Gita", then "chapter X verse Y"
  m = s.match(/\b(?:bg|bhagavad(?:-|\s*)g[iī]t[āa])?(?:.*?\b)?chapter\s*(\d{1,2})\s*(?:verse|v\.?)\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i);
  if (m) {
    const chapter = parseInt(m[1], 10);
    const verse = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : undefined;
    return { chapter, verse, end };
  }
  return null;
}

type Row = {
  work: string;
  chapter: number;
  verse: number;
  verse_label: string | null;
  translation: string | null;
  purport: string | null;
  rank?: number;
};

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { q, k = 8 } = await req.json();
    if (!q || typeof q !== "string") {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json({ error: "Missing SUPABASE envs" }, { status: 500 });
    }
    if (!OPENAI_API_KEY) {
      // Still return verses even if OpenAI key missing
      console.warn("[ask] OPENAI_API_KEY is missing; will return verses only");
    }

    // 1) If a direct verse ref is present, fetch it precisely
    const ref = parseRef(q);
    let rows: Row[] = [];
    if (ref) {
      const work = "Bhagavad-gita As It Is";
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", `eq.${work}`);
      params.set("chapter", `eq.${ref.chapter}`);
      if (ref.end && ref.end > ref.verse) {
        params.append("verse", `gte.${ref.verse}`);
        params.append("verse", `lte.${ref.end}`);
        params.set("order", "verse.asc");
      } else {
        params.set("verse", `eq.${ref.verse}`);
      }
      const url = `${base}?${params.toString()}`;
      const r = await fetch(url, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json({ error: `REST ${r.status}: ${text}` }, { status: 500 });
      }
      rows = (await r.json()) as Row[];
    }

    // 2) Otherwise do full-text search via your RPC (translation + purport)
    if (!rows.length) {
      const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_passages_text`;
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q, k: Number(k) || 8 }),
        cache: "no-store",
      });
      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json({ error: `RPC ${r.status}: ${text}` }, { status: 500 });
      }
      rows = (await r.json()) as Row[];
    }

    // If no verses, we’re done
    if (!rows.length || !OPENAI_API_KEY) {
      return NextResponse.json({
        answer: rows.length ? "Here are related verses." : "No passages found.",
        rows,
      });
    }

    // 3) Ask OpenAI to write a short answer ONLY from these verses
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Keep prompt compact (cost control) and force citations
    const context = rows
      .slice(0, 6)
      .map((r, i) => {
        const label = r.verse_label || String(r.verse);
        const header = `${r.work} ${r.chapter}.${label}`;
        const tr = (r.translation || "").trim();
        const pp = (r.purport || "").trim();
        return `#${i + 1} ${header}\nTranslation: ${tr}\nPurport: ${pp}`;
      })
      .join("\n\n---\n\n");

    const prompt = `
Answer the user's question **only** using the verses below.
- Keep it brief (3–6 sentences).
- Quote scripture by reference like “BG 15.1”.
- If the verses don’t answer, say so and suggest asking differently.

User question:
"${q}"

Verses:
${context}
`.trim();

    // Chat Completions API (official SDK) :contentReference[oaicite:1]{index=1}
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // lightweight, good quality :contentReference[oaicite:2]{index=2}
      messages: [
        { role: "system", content: "You answer using only the provided Bhagavad-gītā verses and purports." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 350,
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "Here are related verses.";

    return NextResponse.json({ answer, rows });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
