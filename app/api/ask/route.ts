// app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/** Parse refs like "BG 15.1", "13:6-7", "chapter 12", "chapter 12 verse 8" */
function parseRef(q: string): null | { chapter: number; verse?: number; end?: number } {
  const s = q.trim();

  // 1) 13.6-7 or 10:21-25 or 15.1
  let m = s.match(/\b(\d{1,2})\s*(?:[.:])\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (m) return { chapter: +m[1], verse: +m[2], end: m[3] ? +m[3] : undefined };

  // 2) BG/Bhagavad Gita "chapter X" (optionally "verse Y-Z")
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
  // If your table has Sanskrit, it will come through because we "select *"
  // @ts-ignore: optional in DB
  sanskrit?: string | null;
  rank?: number;
};

export const runtime = "nodejs";

// Try both possible RPC names so you never hit the 404 again
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
    if (r.status === 404) continue;
    const text = await r.text();
    throw new Error(`RPC ${r.status}: ${text}`);
  }
  throw new Error("RPC 404: Neither search_passages_text nor search_passages_fts exists.");
}

// Shorten a string safely
function shorten(s: string | null | undefined, n: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// Build compact context for a chapter: include Sanskrit (if present), and short quotes
function buildChapterContext(rows: Row[]) {
  return rows
    .sort((a, b) => a.verse - b.verse)
    .map((r) => {
      const label = r.verse_label || String(r.verse);
      const sa = shorten(r.sanskrit || "", 120);
      const tr = shorten(r.translation || "", 260);
      const pp = shorten(r.purport || "", 260);
      return [
        `BG ${r.chapter}.${label}`,
        sa ? `Sanskrit: ${sa}` : "",
        `Translation: ${tr || "(no translation)"}`,
        `Purport: ${pp || "(no purport)"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

// Build compact context for general Q&A (top search hits)
function buildSnippetContext(rows: Row[], cap = 10) {
  return rows
    .slice(0, cap)
    .map((r) => {
      const label = r.verse_label || String(r.verse);
      const sa = shorten(r.sanskrit || "", 80);
      const tr = shorten(r.translation || "", 220);
      const pp = shorten(r.purport || "", 220);
      return [
        `BG ${r.chapter}.${label}`,
        sa ? `Sanskrit: ${sa}` : "",
        `Translation: ${tr || "(no translation)"}`,
        `Purport: ${pp || "(no purport)"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export async function POST(req: NextRequest) {
  try {
    const { q, k = 8 } = await req.json();
    if (!q || typeof q !== "string") return NextResponse.json({ error: "q is required" }, { status: 400 });

    const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) return NextResponse.json({ error: "Missing SUPABASE envs" }, { status: 500 });

    const ref = parseRef(q);
    let rows: Row[] = [];

    // A) Specific verse or range
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
      if (!r.ok) return NextResponse.json({ error: `REST ${r.status}: ${await r.text()}` }, { status: 500 });
      rows = (await r.json()) as Row[];
    }

    // B) Chapter-only → fetch ALL verses in that chapter (no limit)
    let isChapterOnly = false;
    if (!rows.length && ref && !ref.verse) {
      isChapterOnly = true;
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", `eq.Bhagavad-gita As It Is`);
      params.set("chapter", `eq.${ref.chapter}`);
      params.set("order", "verse.asc");
      const r = await fetch(`${base}?${params}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) return NextResponse.json({ error: `REST ${r.status}: ${await r.text()}` }, { status: 500 });
      rows = (await r.json()) as Row[];
    }

    // C) Otherwise full-text search
    if (!rows.length) {
      rows = await rpcSearch({
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
        q,
        k: Number(k) || 8,
      });
    }

    // If no verses, or no OpenAI, just return verses
    if (!rows.length || !OPENAI_API_KEY) {
      return NextResponse.json({
        answer: rows.length ? "Here are related verses." : "No passages found.",
        rows,
      });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    if (isChapterOnly) {
      // ————————————————————————————————————————————————————————————————
      // PRABHUPADA-ONLY CHAPTER MODE (pick most important verses, quote directly)
      // ————————————————————————————————————————————————————————————————
      const chapterCtx = buildChapterContext(rows);
      const chapterNum = rows[0]?.chapter;

      const prompt = `
You will answer ONLY from the provided text: Bhagavad-gītā As It Is (translation & purports by Śrīla Prabhupāda).
User asked about Chapter ${chapterNum}: "${q}"

GOAL
- Give a concise, devotional explanation of this chapter that an everyday reader understands.
- Select the 6–10 MOST IMPORTANT verses to the user's topic (if any). Do NOT list all verses.

STRICT RULES
- Use SHORT DIRECT QUOTES from translation/purport for substance. Do NOT paraphrase quotes.
- Your own words must be minimal, only to connect quotes (e.g., “Prabhupāda says…”).
- If Sanskrit is provided, include the first few words of the śloka before the quotes (optional).
- The CONCLUSION must be from Prabhupāda’s own words (quoted) — not your opinion.
- Cite each bullet as BG ${chapterNum}.x.

FORMAT (plain text, no markdown)
INTRODUCTION: 1–2 short sentences. You may include one short quote.
KEY VERSES (6–10 bullets):
- BG ${chapterNum}.x — [Sanskrit if provided]; "short translation quote"; "short purport quote"
CONCLUSION (Śrīla Prabhupāda): 1–2 sentences formed from direct quotes that express His conclusion.

TEXT (chapter snippets):
${chapterCtx}
`.trim();

      const out = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Use ONLY the provided text. Prefer direct quotes. No outside info." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 1200,
      });

      const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
      return NextResponse.json({ answer, rows });
    } else {
      // ————————————————————————————————————————————————————————————————
      // GENERAL MODE (question or specific verse): pick 3–6 key verses, quote directly
      // ————————————————————————————————————————————————————————————————
      const ctx = buildSnippetContext(rows, 12);

      const prompt = `
Answer ONLY from the provided Bhagavad-gītā As It Is verses/purports by Śrīla Prabhupāda.

User question: "${q}"

RULES
- Select the 3–6 most relevant verses.
- Use SHORT DIRECT QUOTES from translation/purport for substance. Do NOT paraphrase quotes.
- Minimal connector words (e.g., “Prabhupāda explains…”).
- End with a brief CONCLUSION strictly in Prabhupāda’s own words (quoted).

FORMAT (plain text, no markdown)
KEY VERSES:
- BG c.v — "short translation quote"; "short purport quote"
CONCLUSION (Śrīla Prabhupāda): "short quoted line"

TEXT (snippets):
${ctx}
`.trim();

      const out = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Use ONLY the provided text. Prefer direct quotes. No outside info." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 700,
      });

      const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
      return NextResponse.json({ answer, rows });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
