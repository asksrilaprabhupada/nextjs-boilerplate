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
  // optional Sanskrit column supported
  // @ts-ignore
  sanskrit?: string | null;
  rank?: number;
};

export const runtime = "nodejs";

// Try both possible RPC names
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

/** Clip to complete sentences (no artificial ellipsis) */
function clipToSentences(s: string | null | undefined, maxChars: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  // find last sentence end within window
  const window = t.slice(0, maxChars);
  const lastPeriod = Math.max(window.lastIndexOf(". "), window.lastIndexOf("। "), window.lastIndexOf("!") , window.lastIndexOf("?"));
  if (lastPeriod > 60) return window.slice(0, lastPeriod + 1).trim();
  // if no sentence break, hard cut but no ellipsis
  return window.trim();
}

/** Build compact context (keeps full sentences; larger budgets to avoid chopped quotes) */
function buildContext(rows: Row[]) {
  return rows
    .sort((a, b) => a.verse - b.verse)
    .map((r) => {
      const label = r.verse_label || String(r.verse);
      const sa = clipToSentences(r.sanskrit || "", 160);
      const tr = clipToSentences(r.translation || "", 700); // allow a full sentence
      const pp = clipToSentences(r.purport || "", 1100);    // allow a full thought
      return [
        `BG ${r.chapter}.${label}`,
        sa ? `Sanskrit: ${sa}` : "",
        tr ? `Translation: ${tr}` : "Translation: (missing)",
        pp ? `Purport: ${pp}` : "Purport: (missing)",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** Light “importance” heuristic for chapter candidates */
function verseHeuristicScore(r: Row): number {
  const trL = (r.translation || "").length;
  const ppL = (r.purport || "").length;
  const rangeBoost = (r.verse_label || "").includes("-") ? 0.25 : 0;
  return (ppL / 500) + (trL / 300) + rangeBoost;
}

/** Build a small, good candidate set for chapter questions */
async function pickChapterCandidates(
  supabaseUrl: string,
  serviceKey: string,
  q: string,
  chapter: number,
  allInChapter: Row[],
  cap = 12
): Promise<Row[]> {
  let candidates: Row[] = [];
  try {
    const hits = await rpcSearch({ supabaseUrl, serviceKey, q, k: 30 });
    const inChapter = hits.filter((h) => h.chapter === chapter);
    candidates.push(...inChapter);
  } catch {
    // ignore; heuristic fallback
  }

  const seen = new Set<string>();
  const dedup = (arr: Row[]) =>
    arr.filter((r) => {
      const key = `${r.chapter}:${r.verse_label || r.verse}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  candidates = dedup(candidates);

  if (candidates.length < cap) {
    const remaining = allInChapter
      .filter((r) => !seen.has(`${r.chapter}:${r.verse_label || r.verse}`))
      .sort((a, b) => verseHeuristicScore(b) - verseHeuristicScore(a));
    candidates.push(...remaining.slice(0, Math.max(0, cap - candidates.length)));
  }

  return candidates.slice(0, cap);
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

    // B) Chapter-only: fetch all, then choose a compact subset
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
      const allInChapter = (await r.json()) as Row[];
      rows = await pickChapterCandidates(SUPABASE_URL, SERVICE_KEY, q, ref.chapter, allInChapter, 12);
    }

    // C) Otherwise: general text search
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
      // ————————————————————————————————————
      // CHAPTER MODE → Narrative with refs
      // ————————————————————————————————————
      const ctx = buildContext(rows);
      const chapterNum = rows[0]?.chapter;

      const prompt = `
Answer ONLY from the provided Bhagavad-gītā As It Is (translation & purports by Śrīla Prabhupāda).
User asked about Chapter ${chapterNum}: "${q}"

STYLE
- Write a smooth NARRATIVE (not bullets). Connect events/points in order: “this happens, then this…”.
- Use SHORT DIRECT QUOTES from translation/purport (full sentences). Do NOT add "..." unless it is in the original.
- Minimal connector words like “Prabhupāda explains…”, “He emphasizes…”.
- Add verse references in brackets like (BG ${chapterNum}.1), or multiple like (BG ${chapterNum}.28, ${chapterNum}.30).
- The CONCLUSION must be directly quoted from Prabhupāda.

FORMAT (plain text, no markdown)
INTRODUCTION: 1–2 sentences.
NARRATIVE: 5–8 brief paragraphs. Each paragraph may include 1–2 quotes and ends with bracketed refs.
CONCLUSION (Śrīla Prabhupāda): 1–2 sentences, quoted, with refs.

TEXT (subset for Chapter ${chapterNum}):
${ctx}
`.trim();

      const out = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Use ONLY the provided text. Prefer direct quotes. No outside info." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 1100,
      });

      const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
      return NextResponse.json({ answer, rows });
    } else {
      // ————————————————————————————————————
      // GENERAL MODE → Short narrative with refs
      // ————————————————————————————————————
      const ctx = buildContext(rows.slice(0, 12));

      const prompt = `
Answer ONLY from the provided Bhagavad-gītā As It Is text (Śrīla Prabhupāda).

User question: "${q}"

STYLE
- Write a SHORT NARRATIVE (not bullets).
- Use SHORT DIRECT QUOTES from translation/purport (full sentences). Do not add "..." unless original has it.
- Minimal connector words only; substance must be quoted.
- Add verse refs in brackets like (BG c.v) at the end of the paragraph(s).
- End with a brief CONCLUSION, directly quoted from Prabhupāda.

FORMAT (plain text, no markdown)
NARRATIVE: 2–4 brief paragraphs with direct quotes + refs.
CONCLUSION (Śrīla Prabhupāda): one quoted sentence with ref.

TEXT (subset):
${ctx}
`.trim();

      const out = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Use ONLY the provided text. Prefer direct quotes. No outside info." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 750,
      });

      const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
      return NextResponse.json({ answer, rows });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
