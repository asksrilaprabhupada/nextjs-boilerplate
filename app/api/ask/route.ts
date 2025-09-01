// app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/** Parse verse refs like "BG 15.1", "13:6-7", "chapter 2 verse 20" */
function parseRef(q: string): null | { chapter: number; verse?: number; end?: number } {
  const s = q.trim();

  // 1) 13.6-7 or 10:21-25 or 15.1
  let m = s.match(/\b(\d{1,2})\s*(?:[.:])\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (m) return { chapter: +m[1], verse: +m[2], end: m[3] ? +m[3] : undefined };

  // 2) chapter X verse Y (optionally prefixed by “BG/ Bhagavad Gita”)
  m = s.match(/\b(?:bg|bhagavad(?:-|\s*)g[iī]t[āa])?(?:.*?\b)?chapter\s*(\d{1,2})(?:\s*(?:verse|v\.?)\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?)?/i);
  if (m) {
    const chapter = +m[1];
    const verse = m[2] ? +m[2] : undefined;
    const end = m[3] ? +m[3] : undefined;
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

async function rpcSearch({
  supabaseUrl,
  serviceKey,
  q,
  k,
}: {
  supabaseUrl: string;
  serviceKey: string;
  q: string;
  k: number;
}): Promise<Row[]> {
  // Try the “new” name first
  const tryNames = ["search_passages_text", "search_passages_fts"];

  for (const fn of tryNames) {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q, k }),
      cache: "no-store",
    });

    if (r.ok) return (await r.json()) as Row[];

    // If the function name doesn't exist, PostgREST returns 404
    if (r.status === 404) continue;

    // Any other error: surface it
    const text = await r.text();
    throw new Error(`RPC ${r.status}: ${text}`);
  }

  // Neither function exists
  throw new Error(
    "RPC 404: Neither public.search_passages_text nor public.search_passages_fts exists.",
  );
}

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

    // 1) If a specific reference is present, fetch precisely
    const ref = parseRef(q);
    let rows: Row[] = [];
    if (ref && ref.verse) {
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
      const r = await fetch(`${base}?${params}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json({ error: `REST ${r.status}: ${text}` }, { status: 500 });
      }
      rows = (await r.json()) as Row[];
    }

    // If only a chapter (like “chapter 12”), pull a slice of that chapter
    if (!rows.length && ref && !ref.verse) {
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", `eq.Bhagavad-gita As It Is`);
      params.set("chapter", `eq.${ref.chapter}`);
      params.set("order", "verse.asc");
      params.set("limit", String(Math.max(1, Math.min(+k || 8, 20)))); // 1..20
      const r = await fetch(`${base}?${params}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json({ error: `REST ${r.status}: ${text}` }, { status: 500 });
      }
      rows = (await r.json()) as Row[];
    }

    // 2) Otherwise, do text search via RPC (with fallback name)
    if (!rows.length) {
      rows = await rpcSearch({
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
        q,
        k: Number(k) || 8,
      });
    }

    // 3) If no OpenAI key or no rows, return verses only
    if (!OPENAI_API_KEY || !rows.length) {
      return NextResponse.json({
        answer: rows.length ? "Here are related verses." : "No passages found.",
        rows,
      });
    }

    // 4) Summarize strictly from the verses
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const context = rows.slice(0, 6).map((r, i) => {
      const label = r.verse_label || String(r.verse);
      return `#${i + 1} ${r.work} ${r.chapter}.${label}\nTranslation: ${(r.translation || "").trim()}\nPurport: ${(r.purport || "").trim()}`;
    }).join("\n\n---\n\n");

    const prompt = `Answer the question ONLY using the verses below.
- Keep it brief (3–6 sentences).
- Cite like “BG 12.8”.
Question: "${q}"\n\nVerses:\n${context}`;

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Answer using only the provided Bhagavad-gītā verses and purports." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 350,
    });

    const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
    return NextResponse.json({ answer, rows });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
