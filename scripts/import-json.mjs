// scripts/import-json.mjs
// Import Bhagavad-gītā JSON into Supabase via HTTPS (NO OpenAI).
import { config as loadEnv } from "dotenv";
loadEnv({ override: false });

import * as fs from "node:fs";
import * as path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INPUT_FILE = process.env.INGEST_FILE || "public/bhagavadgita.json";
const INGEST_MAX = Number(process.env.INGEST_MAX || 0);

if (!SUPABASE_URL) throw new Error("SUPABASE_URL missing");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

function parseVersesFile(text) {
  const t = (text || "").trim();

  // A) Standard JSON
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return [v];
  } catch {}

  // B) NDJSON (one JSON per line)
  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length) {
    const nd = [];
    let ok = true;
    for (const line of lines) {
      if (!line.startsWith("{") && !line.startsWith("[")) { ok = false; break; }
      try { nd.push(JSON.parse(line)); } catch { ok = false; break; }
    }
    if (ok && nd.length) return nd.flat(); // flatten just in case
  }

  // C) Concatenated objects: {}{}{} (no commas)
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = t.slice(start, i + 1);
        try { objs.push(JSON.parse(slice)); } catch {}
        start = -1;
      }
    }
  }
  if (objs.length) return objs;

  const preview = t.slice(0, 400).replace(/\s+/g, " ");
  throw new Error("Could not parse JSON (array, NDJSON, or concatenated objects required). Preview: " + preview);
}

function normalize(p) {
  const s = p.sections || {};

  const raw = String(p.verse ?? p.verse_number ?? "").trim(); // e.g. "16-18" / "21–22"
  const nums = (raw.match(/\d+/g) || []).map(n => parseInt(n, 10));
  const start = Number.isFinite(nums[0]) ? nums[0] : Number(p.start_verse || 0);
  const end   = Number.isFinite(nums[1]) ? nums[1] : Number(p.end_verse || start);
  const chapter = Number(p.chapter ?? p.chapter_number ?? 0);
  const label = raw || (start ? (end !== start ? `${start}–${end}` : String(start)) : null);

  return {
    ...p, ...s,
    work: p.work || "bhagavad-gita",
    chapter,
    verse: start || 0,
    verse_label: label || null,
    start_verse: start || 0,
    end_verse: end || (start || 0),
    sanskrit: p.sanskrit || s.sanskrit || p.sloka || p.shloka || p.verse_text || p.text || null,
    transliteration: p.transliteration || s.transliteration || null,
    synonyms: p.synonyms || s.synonyms || p.word_meanings || null,
    translation: p.translation || s.translation || p.meaning || null,
    purport: p.purport || s.purport || p.commentary || p.explanation || null,
  };
}

async function callUpsert(payload) {
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
  if (!res.ok) throw new Error(`RPC ${res.status} ${await res.text()}`);
}

async function main() {
  const filePath = path.resolve(INPUT_FILE);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const items = parseVersesFile(raw);

  if (items.length) {
    const sample = items[0];
    console.log(`Parsed ${items.length} items from ${filePath}`);
    console.log("Sample keys:", Object.keys(sample).slice(0, 30).join(", "));
  }

  const list = INGEST_MAX ? items.slice(0, INGEST_MAX) : items;
  let ok = 0, skip = 0;

  for (let i = 0; i < list.length; i++) {
    const n = normalize(list[i]);
    const head = `[${i + 1}/${list.length}] ch ${n.chapter} v ${n.verse_label ?? n.verse}`;

    const hasAnyText = [n.sanskrit, n.transliteration, n.synonyms, n.translation, n.purport]
      .some(v => typeof v === "string" && v.trim());
    if (!hasAnyText) { console.log(`${head} -> no text, skip`); skip++; continue; }

    try {
      await callUpsert({
        work: n.work,
        chapter: n.chapter,
        verse: n.verse,
        verse_label: n.verse_label,
        start_verse: n.start_verse,
        end_verse: n.end_verse,
        sanskrit: n.sanskrit,
        transliteration: n.transliteration,
        synonyms: n.synonyms,
        translation: n.translation,
        purport: n.purport
      });
      ok++;
      if (ok % 25 === 0) console.log(`… upserted ${ok}`);
    } catch (e) {
      console.log(`${head} -> RPC fail: ${e.message || e}`);
      skip++;
    }
  }

  console.log(`Done. Upserted ${ok}, skipped ${skip}.`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
