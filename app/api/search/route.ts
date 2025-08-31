import { NextRequest, NextResponse } from "next/server";

/** Try to parse a verse reference from the user's text.
 *  Accepts: "BG 15.1", "Bhagavad Gita 15:1", "chapter 15 verse 1",
 *           "13.6-7", "10:21-25", etc.
 */
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

  // 2) chapter X verse Y  (optionally prefixed by “BG/ Bhagavad Gita”)
  m = s.match(/\b(?:bg|bhagavad(?:-|\s*)g[iī]t[āa])?(?:.*?\b)?chapter\s*(\d{1,2})\s*(?:verse|v\.?)\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/i);
  if (m) {
    const chapter = parseInt(m[1], 10);
    const verse = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : undefined;
    return { chapter, verse, end };
  }

  return null;
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

    // 1) If the user asked for a specific verse, fetch it directly via PostgREST filters.
    const ref = parseRef(q);
    if (ref) {
      const work = "Bhagavad-gita As It Is"; // matches your table values exactly
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

      const rows = await r.json();
      return NextResponse.json({ rows });
    }

    // 2) Otherwise, do a full-text search RPC
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/search_passages_fts`;
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
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
