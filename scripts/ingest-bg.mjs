// scripts/ingest-bg.mjs
// HTTPS ingest -> Supabase RPC (no DB sockets). Handles verse ranges + sections{}.

import { config as loadEnv } from "dotenv";
loadEnv({ override: false });

import * as fs from "node:fs";
import * as path from "node:path";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; // e.g. https://<ref>.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const INPUT_FILE = process.env.INGEST_FILE || "public/bhagavadgita.json";

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing.");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing.");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing.");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function parseVersesFile(text) {
  const t = (text || "").trim();
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
  } catch {}
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const nd = [];
  let ok = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith("{")) { ok = false; break; }
    try { nd.push(JSON.parse(line)); } catch { ok = false; break; }
  }
  if (ok && nd.length) return nd;

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

// Lift sections{}, keep range label, compute start/end
function normalize(p) {
  const s = p.sections || {};
  const raw = String(p.verse ?? p.verse_number ?? "").trim(); // e.g. "16-18"
  const nums = (raw.match(/\d+/g) || []).map(n => parseInt(n,10));
  const start = nums[0] ?? 0;
  const end   = nums[1] ?? start;

  const chapter = Number(p.chapter ?? p.chapter_number ?? 0);

  return {
    ...p,
    ...s, // lift sections.sanskrit/transliteration/synonyms/translation/purport
    chapter,
    verse: start,                 // numeric (kept for unique key)
    verse_label: raw || null,     // original "16–18"
    start_verse: start,
    end_verse: end,
  };
}

// Build text to embed (robust)
function textForEmbedding(p) {
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
  if (parts.length === 0) {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "string") {
        const s = v.trim();
        if (s && s.length > 1 && k !== "work") parts.push(s);
      }
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > 100_000 ? joined.slice(0, 100_000) : joined;
}

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

async function main() {
  const filePath = path.resolve(INPUT_FILE);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const items = parseVersesFile(raw);
  console.log(`Parsed ${items.length} items from ${filePath}`);
  if (items.length) {
    const keys = Object.keys(items[0]).slice(0, 30);
    console.log(`Sample keys: ${keys.join(", ")}`);
  }

  let done = 0, skipped = 0, noText = 0, embedFail = 0, rpcFail = 0;

  for (const p of items) {
    try {
      const n = normalize(p);
      const text = textForEmbedding(n);
      if (!text) { skipped++; noText++; continue; }

      const { vec, err } = await embed(text);
      if (!vec) { skipped++; if (err === "no-text") noText++; else embedFail++; continue; }

      const payload = {
        work: n.work || "bhagavad-gita",
        chapter: n.chapter,
        verse: n.verse,                // numeric start
        verse_label: n.verse_label,    // original "16–18"
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
      done++;
      if (done % 25 === 0) console.log(`Upserted ${done}/${items.length}...`);
    } catch (e) {
      rpcFail++; skipped++;
      console.error(`Row failed (ch ${p?.chapter ?? p?.chapter_number}, v ${p?.verse ?? p?.verse_number}): ${(e && e.message) || e}`);
    }
  }

  console.log(`Done. Upserted ${done}, skipped ${skipped} (noText ${noText}, embedFail ${embedFail}, rpcFail ${rpcFail}).`);
}

main().catch(e => {
  console.error("Fatal ingest error:", e);
  process.exitCode = 1;
});
