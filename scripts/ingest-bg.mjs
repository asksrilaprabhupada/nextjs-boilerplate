// scripts/ingest-bg.mjs
// Ingest over HTTPS via Supabase REST RPC (no TCP/pg, no IPv6 headaches)

import { config as loadEnv } from "dotenv";
loadEnv({ override: false });

import * as fs from "node:fs";
import * as path from "node:path";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL; // e.g. https://abc123xyz.supabase.co
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
  } catch (_) {}
  // NDJSON
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const nd = [];
  let ok = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith("{")) { ok = false; break; }
    try { nd.push(JSON.parse(line)); } catch { ok = false; break; }
  }
  if (ok && nd.length) return nd;

  // Concatenated {}
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

  throw new Error("Could not parse bhagavadgita.json");
}

function textForEmbedding(p) {
  const parts = [p.sanskrit, p.transliteration, p.synonyms, p.translation, p.purport].filter(Boolean);
  const joined = parts.join("\n\n");
  return joined.length > 100_000 ? joined.slice(0, 100_000) : joined;
}

async function embed(text) {
  const clean = (text || "").trim();
  if (!clean) return null;
  const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: clean });
  return r.data[0].embedding;
}

async function callUpsertRPC(payload) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/upsert_passage`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"   // no row body
    },
    body: JSON.stringify({ p: payload })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase RPC failed (${res.status}): ${text}`);
  }
}

async function main() {
  const filePath = path.resolve(INPUT_FILE);
  if (!fs.existsSync(filePath)) throw new Error(`INGEST_FILE not found: ${filePath}`);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const items = parseVersesFile(raw);

  console.log(`Parsed ${items.length} items from ${filePath}`);

  let done = 0, skipped = 0;
  // modest concurrency to be gentle on APIs
  const concurrency = 4;
  const queue = [...items];

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      try {
        const txt = textForEmbedding(p);
        const vec = await embed(txt);
        if (!vec) { skipped++; continue; }
        // Convert to vector literal string like "[1,2,3]"
        const embStr = `[${vec.join(",")}]`;
        const payload = {
          work: p.work || "bhagavad-gita",
          chapter: Number(p.chapter || p.chapter_number || 0),
          verse: Number(p.verse || p.verse_number || 0),
          sanskrit: p.sanskrit || null,
          transliteration: p.transliteration || null,
          synonyms: p.synonyms || null,
          translation: p.translation || null,
          purport: p.purport || null,
          embedding: embStr
        };
        await callUpsertRPC(payload);
        done++;
        if (done % 25 === 0) console.log(`Upserted ${done}/${items.length}...`);
      } catch (e) {
        console.error(`Failed at chapter ${p?.chapter} verse ${p?.verse}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`Done. Upserted ${done}, skipped ${skipped}.`);
}

main().catch((e) => {
  console.error("Fatal ingest error:", e);
  process.exitCode = 1;
});
