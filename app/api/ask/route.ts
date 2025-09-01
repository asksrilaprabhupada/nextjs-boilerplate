// app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/* ---------------- utils: parsing & normalizing ---------------- */

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
  sanskrit?: string | null;
  rank?: number;
};

export const runtime = "nodejs";

/** Remove chit-chat and normalize terms (diacritics / common variants). */
function normalizeTopic(q: string): string {
  let s = q.toLowerCase();

  // remove filler frames
  s = s
    .replace(/\b(what|which|tell|say|says|entire|whole|please|kindly|about|does|do|can|could|would|should|explain|give)\b/g, " ")
    .replace(/\b(what does.*?about|what .*? about|tell me about|say about)\b/g, " ")
    .replace(/\bbhagavad\s*-?\s*g[iī]t[āa]\b/g, " ") // don't search for this phrase; it's noise in content
    .replace(/\bchapter\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // canonical Sanskrit names
  s = s
    .replace(/\bbhakthi\b/g, "bhakti")
    .replace(/\bbhakth?i-?yoga\b/g, "bhakti-yoga")
    .replace(/\bkrishna\b/g, "kṛṣṇa")
    .replace(/\bkrsna\b/g, "kṛṣṇa")
    .replace(/\bkrṣṇa\b/g, "kṛṣṇa")
    .replace(/\bkr̥ṣṇa\b/g, "kṛṣṇa");

  return s.trim();
}

/** Build expanded candidate queries (works with websearch_to_tsquery). */
function expandQueries(original: string): string[] {
  const out: string[] = [];
  const norm = normalizeTopic(original);
  const base = norm || original.trim();

  out.push(original.trim()); // try as typed (sometimes it works)
  if (base && base !== original.trim()) out.push(base);

  // light synonym expansion
  const q = ` ${base} `;
  const hasBhakti = /\bbhakti\b/.test(q) || /\bbhakti-yoga\b/.test(q);
  const hasKrishna = /\bkṛṣṇa\b/.test(q);

  if (hasBhakti) {
    out.push(`bhakti "devotional service" "bhakti-yoga" devotion`);
  }
  if (hasKrishna) {
    // “Supreme Personality of Godhead” appears in many purports
    out.push(`kṛṣṇa "Supreme Personality of Godhead"`);
  }

  // unique, shortest-first
  return Array.from(new Set(out)).sort((a, b) => a.length - b.length);
}

/* ---------------- supabase helpers ---------------- */

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
    throw new Error(`RPC ${r.status}: ${await r.text()}`);
  }
  throw new Error("RPC 404: Neither search_passages_text nor search_passages_fts exists.");
}

function clip(s: string | null | undefined, max: number) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const p = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return (p > 50 ? cut.slice(0, p + 1) : cut).trim();
}

function buildContext(rows: Row[]) {
  return rows
    .sort((a, b) => a.verse - b.verse)
    .map((r) => {
      const label = r.verse_label || String(r.verse);
      return [
        `BG ${r.chapter}.${label}`,
        r.sanskrit ? `Sanskrit: ${clip(r.sanskrit, 160)}` : "",
        `Translation: ${clip(r.translation, 700) || "(missing)"}`,
        `Purport: ${clip(r.purport, 1100) || "(missing)"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function verseScore(r: Row) {
  return (r.purport?.length || 0) / 500 + (r.translation?.length || 0) / 300 + ((r.verse_label || "").includes("-") ? 0.25 : 0);
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
      return { label: `BG ${r.chapter}.${label}`, url: toVedabaseUrlBG(r.chapter, r.verse_label, r.verse) };
    })
    .filter(Boolean) as { label: string; url: string }[];
}

function extractFinal(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/BEGIN_FINAL\s*([\s\S]*?)\s*END_FINAL/i);
  return m ? m[1].trim() : null;
}

/* ---------------- main handler ---------------- */

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

    // 1) direct verse/range
    if (ref?.verse) {
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

    // 2) chapter summary
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
      // pick heavier verses (more purport) if we must cap
      rows = all
        .slice()
        .sort((a, b) => verseScore(b) - verseScore(a))
        .slice(0, 12);
    }

    // 3) semantic text search with normalization
    if (!rows.length) {
      const candidates = expandQueries(q);
      for (const qTry of candidates) {
        const hits = await rpcSearch({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, q: qTry, k: Math.max(+k || 8, 20) });
        if (hits?.length) {
          rows = hits;
          break;
        }
      }
    }

    const sources = makeSources(rows);

    // if still nothing, answer gently and stop
    if (!rows.length || !OPENAI_API_KEY) {
      const friendly =
        "No passages found. Try a simpler word like “bhakti”, “kṛṣṇa”, “yoga”, or ask for a chapter (e.g., “BG 12 summary”).";
      return NextResponse.json({ answer: friendly, rows, sources });
    }

    // 4) single OpenAI call with two silent checks
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const ctx = buildContext(isChapterOnly ? rows : rows.slice(0, 12));
    const chapterNum = rows[0]?.chapter;

    const prompt = (isChapterOnly
      ? `
You are to answer ONLY from the following excerpts of Bhagavad-gītā As It Is (Śrīla Prabhupāda). Perform TWO SILENT VERIFICATION PASSES inside your head; do NOT print them. Finally, output ONLY the final answer between literal tags:
BEGIN_FINAL
...final answer...
END_FINAL

SILENT CHECK #1 (Support): Ensure every claim is supported by the provided text (translation/purport). Prefer brief direct quotes. If a claim is not supported, remove or rephrase to match the text.
SILENT CHECK #2 (Alignment): Ensure the conclusion matches Śrīla Prabhupāda’s stated meaning. Use his own words when possible.

STYLE
- Write a smooth NARRATIVE (not bullets), connecting the flow of the chapter.
- Use SHORT DIRECT QUOTES (full sentences) only from translation/purport; no invented ellipses.
- Add refs in brackets like (BG ${chapterNum}.1) or (BG ${chapterNum}.28, ${chapterNum}.30).
- The CONCLUSION must be directly quoted or tightly paraphrased from Prabhupāda.

FORMAT INSIDE THE TAGS (plain text):
INTRODUCTION: 1–2 sentences.
NARRATIVE: 5–8 short paragraphs with quotes + refs.
CONCLUSION (Śrīla Prabhupāda): 1–2 quoted sentences with refs.

TEXT:
${ctx}
`.trim()
      : `
Answer ONLY from the provided Bhagavad-gītā As It Is text (Śrīla Prabhupāda). Do TWO SILENT VERIFICATION PASSES (Support + Alignment) and output ONLY the final answer between:
BEGIN_FINAL
...final answer...
END_FINAL

STYLE
- Short NARRATIVE (not bullets).
- Use SHORT DIRECT QUOTES from translation/purport; no invented ellipses.
- End paragraphs with refs like (BG c.v).
- Finish with a brief CONCLUSION quoted from Prabhupāda.

TEXT:
${ctx}
`.trim());

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: isChapterOnly ? 1100 : 750,
      messages: [
        {
          role: "system",
          content:
            "Use ONLY the provided Bhagavad-gita As It Is text (translation/purport). Think through checks silently; output ONLY the final section requested.",
        },
        { role: "user", content: prompt },
      ],
    });

    const raw = out.choices[0]?.message?.content?.trim() || "";
    const finalAnswer = extractFinal(raw) ?? raw;

    return NextResponse.json({ answer: finalAnswer, rows, sources });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
