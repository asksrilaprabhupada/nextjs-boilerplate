// app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

function parseRef(q: string): null | { chapter: number; verse?: number; end?: number } {
  const s = q.trim();
  let m = s.match(/\b(\d{1,2})\s*(?:[.:])\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (m) return { chapter: +m[1], verse: +m[2], end: m[3] ? +m[3] : undefined };
  m = s.match(/\b(?:bg|bhagavad(?:-|\s*)g[iī]t[āa])?(?:.*?\b)?chapter\s*(\d{1,2})(?:\s*(?:verse|v\.?)\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?)?/i);
  if (m) return { chapter: +m[1], verse: m[2] ? +m[2] : undefined, end: m[3] ? +m[3] : undefined };
  return null;
}

type Row = {
  work: string;
  chapter: number;
  verse: number;
  verse_label: string | null;
  translation: string | null;
  purport: string | null;
  // optional:
  // @ts-ignore
  sanskrit?: string | null;
  rank?: number;
};

export const runtime = "nodejs";

async function rpcSearch({
  supabaseUrl, serviceKey, q, k,
}: { supabaseUrl: string; serviceKey: string; q: string; k: number }): Promise<Row[]> {
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
    throw new Error(`RPC ${r.status}: ${await r.text()}`);
  }
  throw new Error("RPC 404: Neither search_passages_text nor search_passages_fts exists.");
}

function clipToSentences(s: string | null | undefined, maxChars: number): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  const w = t.slice(0, maxChars);
  const p = Math.max(w.lastIndexOf(". "), w.lastIndexOf("। "), w.lastIndexOf("!"), w.lastIndexOf("?"));
  if (p > 60) return w.slice(0, p + 1).trim();
  return w.trim();
}

function buildContext(rows: Row[]) {
  return rows
    .sort((a, b) => a.verse - b.verse)
    .map((r) => {
      const label = r.verse_label || String(r.verse);
      const sa = clipToSentences(r.sanskrit || "", 160);
      const tr = clipToSentences(r.translation || "", 700);
      const pp = clipToSentences(r.purport || "", 1100);
      return [
        `BG ${r.chapter}.${label}`,
        sa ? `Sanskrit: ${sa}` : "",
        tr ? `Translation: ${tr}` : "Translation: (missing)",
        pp ? `Purport: ${pp}` : "Purport: (missing)",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function verseHeuristicScore(r: Row): number {
  const trL = (r.translation || "").length;
  const ppL = (r.purport || "").length;
  const rangeBoost = (r.verse_label || "").includes("-") ? 0.25 : 0;
  return (ppL / 500) + (trL / 300) + rangeBoost;
}

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
    candidates.push(...hits.filter((h) => h.chapter === chapter));
  } catch {}
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

function toVedabaseUrlBG(chapter: number, verse_label: string | null, verse: number) {
  const label = (verse_label || String(verse)).replace(/[^\d-]/g, "");
  return `https://vedabase.io/en/library/bg/${chapter}/${label}/`;
}

function makeSources(rows: Row[]) {
  const seen = new Set<string>();
  return rows
    .sort((a, b) => a.verse - b.verse)
    .map((r) => {
      const label = r.verse_label || String(r.verse);
      const key = `${r.chapter}:${label}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        label: `BG ${r.chapter}.${label}`,
        url: toVedabaseUrlBG(r.chapter, r.verse_label, r.verse),
      };
    })
    .filter(Boolean) as { label: string; url: string }[];
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
    let isChapterOnly = false;

    if (ref && ref.verse) {
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", "eq.Bhagavad-gita As It Is");
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

    if (!rows.length && ref && !ref.verse) {
      isChapterOnly = true;
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", "eq.Bhagavad-gita As It Is");
      params.set("chapter", `eq.${ref.chapter}`);
      params.set("order", "verse.asc");
      const r = await fetch(`${base}?${params}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) return NextResponse.json({ error: `REST ${r.status}: ${await r.text()}` }, { status: 500 });
      const all = (await r.json()) as Row[];
      rows = await pickChapterCandidates(SUPABASE_URL, SERVICE_KEY, q, ref.chapter, all, 12);
    }

    if (!rows.length) {
      rows = await rpcSearch({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, q, k: Number(k) || 8 });
    }

    const sources = makeSources(rows);

    if (!rows.length || !OPENAI_API_KEY) {
      return NextResponse.json({
        answer: rows.length ? "Here are related verses from the Bhagavad-gītā." : "No passages found.",
        rows,
        sources,
      });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const ctx = buildContext(isChapterOnly ? rows : rows.slice(0, 12));
    const chapterNum = rows[0]?.chapter;

    const prompt = isChapterOnly
      ? `
Answer ONLY from the provided Bhagavad-gītā As It Is (Śrīla Prabhupāda).
User asked about Chapter ${chapterNum}: "${q}"

STYLE
- Write a smooth NARRATIVE (not bullets). Connect events in order.
- Use SHORT DIRECT QUOTES (full sentences) from translation/purport only; no invented ellipses.
- Use minimal connector words; substance must be Prabhupāda’s words.
- Add verse refs in brackets like (BG ${chapterNum}.1) or (BG ${chapterNum}.28, ${chapterNum}.30).
- The CONCLUSION must be directly quoted from Prabhupāda.

FORMAT (plain text)
INTRODUCTION: 1–2 sentences.
NARRATIVE: 5–8 short paragraphs with quotes + refs.
CONCLUSION (Śrīla Prabhupāda): 1–2 quoted sentences with refs.

TEXT:
${ctx}
`.trim()
      : `
Answer ONLY from the provided Bhagavad-gītā As It Is text (Śrīla Prabhupāda).

Question: "${q}"

STYLE
- SHORT NARRATIVE (not bullets).
- Use SHORT DIRECT QUOTES (full sentences) from translation/purport only; no invented ellipses.
- Minimal connectors; end paragraphs with refs like (BG c.v).
- Finish with a brief CONCLUSION quoted from Prabhupāda.

FORMAT (plain text)
NARRATIVE: 2–4 short paragraphs.
CONCLUSION (Śrīla Prabhupāda): one quoted sentence with ref.

TEXT:
${ctx}
`.trim();

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: isChapterOnly ? 1100 : 750,
      messages: [
        { role: "system", content: "Use ONLY the provided text. Prefer direct quotes. No outside info." },
        { role: "user", content: prompt },
      ],
    });

    const answer = out.choices[0]?.message?.content?.trim() || "Here are related verses.";
    return NextResponse.json({ answer, rows, sources });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
