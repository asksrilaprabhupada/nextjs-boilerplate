import { NextRequest, NextResponse } from "next/server";

/** Parse "BG 15.1", "13:6-7", "chapter 12 verse 1", or just "chapter 12" */
function parseRef(q: string): null | { chapter: number; verse?: number; end?: number } {
  const s = q.trim();

  let m = s.match(/\b(\d{1,2})\s*(?:[.:])\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (m) return { chapter: +m[1], verse: +m[2], end: m[3] ? +m[3] : undefined };

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

export async function POST(req: NextRequest) {
  try {
    const { q, k = 5 } = await req.json();
    if (!q || typeof q !== "string") {
      return NextResponse.json({ error: "q is required" }, { status: 400 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json(
        { error: "Missing env vars", details: { SUPABASE_URL: !!SUPABASE_URL, SERVICE_KEY: !!SERVICE_KEY } },
        { status: 500 }
      );
    }

    // 1) Direct verse (or range)
    const ref = parseRef(q);
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

      const url = `${base}?${params.toString()}`;
      const r = await fetch(url, {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
        cache: "no-store",
      });

      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json({ error: `REST ${r.status}: ${text}` }, { status: 500 });
      }

      const rows = (await r.json()) as Row[];
      return NextResponse.json({ rows });
    }

    // 1b) Only chapter (e.g., “chapter 12”)
    if (ref && !ref.verse) {
      const base = `${SUPABASE_URL}/rest/v1/passages`;
      const params = new URLSearchParams();
      params.set("select", "*");
      params.set("work", `eq.Bhagavad-gita As It Is`);
      params.set("chapter", `eq.${ref.chapter}`);
      params.set("order", "verse.asc");
      params.set("limit", "20");
      const r = await fetch(`${base}?${params}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json({ error: `REST ${r.status}: ${text}` }, { status: 500 });
      }
      const rows = (await r.json()) as Row[];
      return NextResponse.json({ rows });
    }

    // 2) Full-text search (with fallback RPC name)
    const rows = await rpcSearch({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      q,
      k: Number(k) || 5,
    });

    return NextResponse.json({ rows });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
