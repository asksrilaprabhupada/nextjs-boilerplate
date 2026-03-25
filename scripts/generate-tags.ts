/**
 * FAST Tag Generation — Gemini 2.5 Flash Lite
 * Separate daily quota from Flash. 50 parallel. No thinking.
 *
 * Usage: npx tsx scripts/generate-tags.ts
 * Test:  npx tsx scripts/generate-tags.ts --test
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "fs";
import { resolve } from "path";

const FAILED_LOG = resolve(__dirname, "..", "failed-verses.log");

function loadEnv() {
  try {
    const envPath = resolve(__dirname, "..", ".env.local");
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

loadEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required env vars: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 1500;
const TEST_MODE = process.argv.includes("--test");
const startTime = Date.now();

if (TEST_MODE) console.log("TEST MODE - processing only 5 rows\n");

async function callGemini(prompt: string): Promise<string> {
  const res = await fetch(GEMINI_URL + "?key=" + GEMINI_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: "application/json"
      }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("Gemini " + res.status + ": " + text.substring(0, 300));
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function extractJSON(raw: string): any {
  if (!raw || raw.trim().length === 0) return null;
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  cleaned = cleaned.substring(first, last + 1);
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(cleaned); } catch {}
  try { return JSON.parse(cleaned.replace(/'/g, '"')); } catch {}
  return null;
}

function buildTags(parsed: any): string[] {
  const tags: string[] = [];
  if (Array.isArray(parsed.topics)) tags.push(...parsed.topics.filter((t: any) => typeof t === "string"));
  if (Array.isArray(parsed.sanskrit_terms)) tags.push(...parsed.sanskrit_terms.filter((t: any) => typeof t === "string"));
  if (Array.isArray(parsed.questions)) tags.push(...parsed.questions.filter((t: any) => typeof t === "string"));
  if (parsed.summary && typeof parsed.summary === "string") tags.push("SUMMARY: " + parsed.summary);
  return tags;
}

function elapsed(): string {
  return ((Date.now() - startTime) / 60000).toFixed(1) + "m";
}

async function tagOneVerse(verse: any, chapterMap: any): Promise<boolean> {
  const ch = chapterMap[verse.chapter_id] || { canto_or_division: "", chapter_number: "" };
  const purportExcerpt = (verse.purport || "").slice(0, 800);
  const prompt = "You are an expert on Srila Prabhupada's teachings and ISKCON devotee culture.\n\nRead this verse and purport from " + verse.scripture + " " + (ch.canto_or_division || "") + "." + (ch.chapter_number || "") + "." + verse.verse_number + ".\n\nTranslation: \"" + (verse.translation || "No translation") + "\"\nPurport (excerpt): \"" + (purportExcerpt || "No purport") + "\"\n\nReturn a JSON object with these fields:\n{\n  \"topics\": [\"10-15 English search terms a devotee might type to find this verse\"],\n  \"sanskrit_terms\": [\"5-8 relevant Sanskrit terms with and without diacritics\"],\n  \"questions\": [\"3-5 questions a devotee might ask that this verse answers\"],\n  \"summary\": \"1-2 sentence summary of the key teaching\"\n}";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callGemini(prompt);
      if (TEST_MODE) console.log("  OK (" + verse.scripture + " " + verse.verse_number + "): " + raw.substring(0, 200) + "...");
      const parsed = extractJSON(raw);
      if (parsed) {
        const tags = buildTags(parsed);
        if (tags.length > 0) {
          const { error } = await supabase.from("verses").update({ tags }).eq("id", verse.id);
          if (!error) return true;
        }
      }
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      if (TEST_MODE) console.log("  ERR (" + verse.verse_number + "): " + (err.message || err).substring(0, 200));
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  appendFileSync(FAILED_LOG, "verse:" + verse.id + "\n");
  return false;
}

async function tagOneProse(row: any): Promise<boolean> {
  const textExcerpt = (row.body_text || "").slice(0, 800);
  const prompt = "You are an expert on Srila Prabhupada's teachings and ISKCON devotee culture.\n\nRead this paragraph from \"" + row.book_slug + "\", paragraph " + row.paragraph_number + ".\n\nText (excerpt): \"" + textExcerpt + "\"\n\nReturn a JSON object with these fields:\n{\n  \"topics\": [\"10-15 English search terms a devotee might type to find this passage\"],\n  \"sanskrit_terms\": [\"5-8 relevant Sanskrit terms with and without diacritics\"],\n  \"questions\": [\"3-5 questions a devotee might ask that this passage answers\"],\n  \"summary\": \"1-2 sentence summary of the key teaching\"\n}";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callGemini(prompt);
      if (TEST_MODE) console.log("  OK (prose " + row.paragraph_number + "): " + raw.substring(0, 200) + "...");
      const parsed = extractJSON(raw);
      if (parsed) {
        const tags = buildTags(parsed);
        if (tags.length > 0) {
          const { error } = await supabase.from("prose_paragraphs").update({ tags }).eq("id", row.id);
          if (!error) return true;
        }
      }
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      if (TEST_MODE) console.log("  ERR (prose " + row.paragraph_number + "): " + (err.message || err).substring(0, 200));
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  appendFileSync(FAILED_LOG, "prose:" + row.id + "\n");
  return false;
}

async function processVerses() {
  console.log("\n=== Processing verses ===\n");
  let allIds: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("verses").select("id").or("tags.is.null,tags.eq.{}").range(from, from + 999);
    if (error || !data || data.length === 0) break;
    allIds.push(...data.map((r: any) => r.id));
    if (data.length < 1000) break;
    from += 1000;
  }
  if (TEST_MODE) allIds = allIds.slice(0, 5);
  const total = allIds.length;
  console.log("Found " + total + " verses needing tags");
  if (total === 0) return;

  let processed = 0;
  let errors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);
    const { data: verses, error } = await supabase.from("verses").select("id, scripture, verse_number, translation, purport, chapter_id").in("id", batchIds);
    if (error || !verses) { errors += batchIds.length; continue; }

    const chapterIds = [...new Set(verses.map((v: any) => v.chapter_id).filter(Boolean))];
    let chapterMap: any = {};
    if (chapterIds.length > 0) {
      const { data: chapters } = await supabase.from("chapters").select("id, canto_or_division, chapter_number").in("id", chapterIds);
      if (chapters) for (const c of chapters) chapterMap[c.id] = { canto_or_division: c.canto_or_division, chapter_number: c.chapter_number };
    }

    const results = await Promise.all(verses.map((v: any) => tagOneVerse(v, chapterMap)));
    for (const success of results) {
      if (success) processed++; else errors++;
    }

    const totalDone = processed + errors;
    if (totalDone % 100 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      const mins = (Date.now() - startTime) / 60000;
      const rate = mins > 0.1 ? (processed / mins).toFixed(0) : "...";
      const remaining = mins > 0.1 ? Math.ceil((total - processed) / (processed / mins)) : "...";
      console.log("  " + processed + " / " + total + " (" + ((processed/total)*100).toFixed(1) + "%) | " + errors + " err | " + rate + "/min | ~" + remaining + " min left | " + elapsed());
    }

    if (i + BATCH_SIZE < allIds.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }
  console.log("\nVerses done: " + processed + " tagged, " + errors + " errors | " + elapsed());
}

async function processProse() {
  console.log("\n=== Processing prose_paragraphs ===\n");
  let allIds: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("prose_paragraphs").select("id").or("tags.is.null,tags.eq.{}").range(from, from + 999);
    if (error || !data || data.length === 0) break;
    allIds.push(...data.map((r: any) => r.id));
    if (data.length < 1000) break;
    from += 1000;
  }
  if (TEST_MODE) allIds = allIds.slice(0, 5);
  const total = allIds.length;
  console.log("Found " + total + " prose paragraphs needing tags");
  if (total === 0) return;

  let processed = 0;
  let errors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);
    const { data: rows, error } = await supabase.from("prose_paragraphs").select("id, book_slug, paragraph_number, body_text, chapter_id").in("id", batchIds);
    if (error || !rows) { errors += batchIds.length; continue; }

    const results = await Promise.all(rows.map((r: any) => tagOneProse(r)));
    for (const success of results) {
      if (success) processed++; else errors++;
    }

    const totalDone = processed + errors;
    if (totalDone % 100 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      const mins = (Date.now() - startTime) / 60000;
      const rate = mins > 0.1 ? (processed / mins).toFixed(0) : "...";
      const remaining = mins > 0.1 ? Math.ceil((total - processed) / (processed / mins)) : "...";
      console.log("  " + processed + " / " + total + " (" + ((processed/total)*100).toFixed(1) + "%) | " + errors + " err | " + rate + "/min | ~" + remaining + " min left | " + elapsed());
    }

    if (i + BATCH_SIZE < allIds.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }
  console.log("\nProse done: " + processed + " tagged, " + errors + " errors | " + elapsed());
}

async function main() {
  console.log("=== FAST Tag Generation (Gemini 2.5 Flash Lite) ===");
  console.log("50 parallel | Separate daily quota from Flash\n");
  await processVerses();
  if (!TEST_MODE) await processProse();
  console.log("\n=== ALL DONE === | Total time: " + elapsed());
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });