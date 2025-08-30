// scripts/ingest-bg.mjs
// Ingest Bhagavad-gītā JSON into Supabase via HTTPS RPCs.
// - Supports verse ranges like "16-18" (stores start/end + verse_label).
// - Lifts fields from `sections{}` to top-level.
// - Builds embeddings with OpenAI (text-embedding-3-small).
// - Clear per-item logs; optional limits and concurrency via env.
//
// Env (CI/local):
//   OPENAI_API_KEY=sk-...
//   SUPABASE_URL=https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<service_role>
//   INGEST_FILE=public/bhagavadgita.json
//   EMBEDDING_MODEL=text-embedding-3-small
//   INGEST_MAX=0            # optional; if >0, only process first N items
//   INGEST_CONCURRENCY=2    # optional; default 2

import { config as loadEnv } from "dotenv";
loadEnv({ override: false });

import * as fs from "node:fs";
import * as path from "node:path";
import OpenAI from "openai";

// ---- env checks ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; // https://<ref>.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const INPUT_FILE = process.env.INGEST_FILE || "public/bhagavadgita.json";
const INGEST_MAX = Number(process.env.INGEST_MAX || 0);
const CONCURRENCY = Math.max(1, Number(process.env.INGEST_CONCURRENCY || 2));

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing.");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing.");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing.");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- file parsing (array / NDJSON / concatenated objects) ----------
function parseVersesFile(text) {
  const t = (text || "").trim();

  // Standard JSON
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
  } catch {}

  // NDJSON
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const nd = [];
  let ok = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith("{")) { ok = false; break; }
    try { nd.push(JSON.parse(line)); } catch { ok = false; break; }
  }
  if (ok && nd.length) return nd;

  // Concatenated {}{}...
  const objs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = t.slice(start, i + 1);
        try { objs.push(JSON.parse(slice)); } catch {}
        start = -1;
      }
    }
  }
  if (objs.length) return objs;

  throw new Error("Could not parse bhagavadgita.json (array, NDJSON, or concatenated objects expected).");
}

// ---------- normalizer: lift sections + decode verse range ----------
function normalize(p) {
  const s = p.sections || {};

  const raw = String(p.verse ?? p.verse_number ?? "").trim(); // e.g. "16-18" or "21–22"
  const nums = (raw.match(/\d+/g) || []).map(n => parseInt(n, 10));
  let start = nums[0];
  let end = nums[1];

  // allow explicit start_verse/end_verse if present
  if (!Number.isInteger(start)) start = p.start_verse != null ? Number(p.start_verse) : 0;
  if (!Number.isInteger(end))   end   = p.end_verse   != null ? Number(p.end_verse)   : start;

  const chapter = Number(p.chapter ?? p.chapter_number ?? 0);

  // if there is no label but we have numbers, synthesize a label
  const label = raw || (start ? (end && end !== start ? `${start}–${end}` : String(start)) : null);

  return {
    ...p,
    ...s,                 // lift fields from sections{}
    chapter,
    verse: start || 0,    // keep legacy numeric field (start)
    verse_label: label || null,
    start_verse: start || 0,
    end_verse: end || (start || 0),
  };
}

// ---------- text selection for embedding ----------
function textForEmbedding(p) {
  // Preferred keys likely to have the text we want
  const preferred = [
    "sanskrit","sloka","shloka","verse_text","text",
    "transliteration","synonyms","word_meanings",
    "translation","meaning",
    "purport","commentary","explanation","notes"
  ];

  const parts = [];
  for (const k of preferred) {
    const v = p?.[k];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  }

  // Fallback: include any non-trivial string fields (skip tiny labels)
  if (parts.length === 0) {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "string") {
        const s = v.trim();
        if (s && s.length > 1 && !/^work$/.test(k)) parts.push(s);
      }
    }
  }

  const joined = parts.join("\n\n");
  return joined.length > 100_000 ? joined.slice(0, 100_000) : joined;
}

// ---------- embeddings ----------
async function embed(text) {
  const clean = (text || "").trim();
  if (!clean) return { vec: null, err: "no-text" };
  try {
    const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: clean });
    return { vec: r.data[0].embedding, err: null };
  } catch (e) {
    return { vec: null, err: (e && e.message) || "embed-failed" };
  }
}

// ---------- Supabase RPC ----------
async function callUpsertRPC(payload) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/upsert_passage`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ p: payload })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`RPC ${res.status}: ${t}`);
  }
}

// ---------- one item ----------
async function processOne(raw, idx, total) {
  const n = normalize(raw);
  const label = n.verse_label ?? n.verse;
  const head = `[${idx + 1}/${total}] ch ${n.chapter} v ${label}`;

  const text = textForEmbedding(n);
  if (!text) {
    console.log(`${head} -> no text, skip`);
    return { done: 0, skipped: 1, noText: 1, embedFail: 0, rpcFail: 0 };
  }

  const { vec, err } = await embed(text);
  if (!vec) {
    console.log(`${head} -> embed fail: ${err}`);
    return { done: 0, skipped: 1, noText: 0, embedFail: 1, rpcFail: 0 };
  }

  const payload = {
    work: n.work || "bhagavad-gita",
    chapter: n.chapter,
    verse: n.verse,                 // numeric start
    verse_label: n.verse_label,     // "16–18"
    start_verse: n.start_verse,
    end_verse: n.end_verse,
    sanskrit: n.sanskrit || n.sloka || n.shloka || n.verse_text || n.text || null,
    transliteration: n.transliteration || null,
    synonyms: n.synonyms || n.word_meanings || null,
    translation: n.translation || n.meaning || null,
    purport: n.purport || n.commentary || n.explanation || null,
    embedding: `[${vec.join(",")}]`,
  };

  await callUpsertRPC(payload);
  console.log(`${head} -> upserted OK`);
  return { done: 1, skipped: 0, noText: 0, embedFail: 0, rpcFail: 0 };
}

// ---------- main ----------
async function main() {
  const filePath = path.resolve(INPUT_FILE);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const items = parseVersesFile(raw);

  console.log(`Parsed ${items.length} items from ${filePath}`);
  if (items.length) {
    const keys = Object.keys(items[0]).slice(0, 30);
    console.log(`Sample keys: ${keys.join(", ")}`);
  }

  const list = INGEST_MAX ? items.slice(0, INGEST_MAX) : items;
  console.log(`Ingesting ${list.length} items with concurrency=${CONCURRENCY} …`);

  const total = list.length;
  let stats = { done: 0, skipped: 0, noText: 0, embedFail: 0, rpcFail: 0 };
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= total) break;
      try {
        const r = await processOne(list[idx], idx, total);
        stats.done += r.done;
        stats.skipped += r.skipped;
        stats.noText += r.noText;
        stats.embedFail += r.embedFail;
        stats.rpcFail += r.rpcFail;
      } catch (e) {
        console.log(`[${idx + 1}/${total}] unexpected error: ${e?.message || e}`);
        stats.skipped += 1;
        stats.rpcFail += 1;
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(
    `Done. Upserted ${stats.done}, skipped ${stats.skipped} ` +
    `(noText ${stats.noText}, embedFail ${stats.embedFail}, rpcFail ${stats.rpcFail}).`
  );
}

main().catch(e => {
  console.error("Fatal ingest error:", e);
  process.exitCode = 1;
});
