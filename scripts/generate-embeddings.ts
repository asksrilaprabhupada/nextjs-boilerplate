/**
 * Embedding Generation v4 — BATCH EVERYTHING
 *
 * Gemini batchEmbedContents: 40 texts → 1 API call → 40 embeddings
 * Supabase batch_set_embeddings RPC: 40 embeddings → 1 DB call → 40 updates
 *
 * Total: 2 HTTP round-trips per 40 rows. Zero connection pool contention.
 *
 * Usage: npx tsx scripts/generate-embeddings.ts
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Gemini batch endpoint — sends N texts, gets N embeddings in ONE call
const BATCH_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents";
const EXPECTED_DIMS = 1536;
const BATCH_SIZE = 40; // texts per Gemini batch call
const BATCH_DELAY_MS = 300;

const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 60000).toFixed(1) + "m";

// ---------------------------------------------------------------------------
// Gemini BATCH embed — 40 texts in, 40 embeddings out, ONE API call
// ---------------------------------------------------------------------------
async function batchEmbed(texts: string[]): Promise<number[][]> {
  const requests = texts.map((text) => ({
    model: "models/gemini-embedding-2-preview",
    content: { parts: [{ text }] },
    outputDimensionality: EXPECTED_DIMS,
    taskType: "RETRIEVAL_DOCUMENT",
  }));

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BATCH_EMBED_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });

      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        console.log(`  Gemini ${res.status}, retrying in ${3 * attempt}s...`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini batch ${res.status}: ${body.substring(0, 200)}`);
      }

      const data = await res.json();
      const embeddings: number[][] = (data.embeddings || []).map(
        (e: { values: number[] }) => e.values
      );

      if (embeddings.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, got ${embeddings.length}`);
      }

      // Validate dimensions
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i].length !== EXPECTED_DIMS) {
          throw new Error(`Embedding ${i}: expected ${EXPECTED_DIMS} dims, got ${embeddings[i].length}`);
        }
      }

      return embeddings;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Supabase BATCH write — 40 embeddings in ONE database call
// ---------------------------------------------------------------------------
async function batchWrite(
  table: "verses" | "prose_paragraphs",
  ids: string[],
  embeddings: number[][]
): Promise<number> {
  // Convert embeddings to vector string format: "[0.1,0.2,...]"
  const embStrings = embeddings.map((emb) => `[${emb.join(",")}]`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data, error } = await supabase.rpc("batch_set_embeddings", {
        p_table: table,
        p_ids: ids,
        p_embeddings: embStrings,
      });

      if (error) {
        const msg = error.message || "";
        if ((msg.includes("timeout") || msg.includes("502")) && attempt < 3) {
          console.log(`  DB write retry ${attempt}...`);
          await new Promise((r) => setTimeout(r, 5000 * attempt));
          continue;
        }
        throw new Error(`DB batch write: ${msg.substring(0, 100)}`);
      }

      return data as number;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Fetch IDs via RPC (uses partial index, 5min timeout)
// ---------------------------------------------------------------------------
async function fetchAllNullIds(table: "verses" | "prose_paragraphs"): Promise<string[]> {
  const allIds: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.rpc("fetch_null_embedding_ids", {
      p_table: table,
      p_limit: 1000,
      p_offset: offset,
    });

    if (error) {
      console.error(`  ID fetch error at offset ${offset}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allIds.push(...data.map((r: { id: string }) => r.id));
    if (data.length < 1000) break;
    offset += 1000;
  }

  return allIds;
}

// ---------------------------------------------------------------------------
// Build text helpers
// ---------------------------------------------------------------------------
function buildVerseText(v: any, ch: any): string {
  const parts: string[] = [];
  parts.push(`[${v.scripture} ${ch.canto_or_division || "?"}.${ch.chapter_number || "?"}.${v.verse_number}]`);
  if (v.tags?.length) parts.push(`Topics: ${v.tags.join(", ")}.`);
  if (v.translation) parts.push(`Translation: ${v.translation}.`);
  if (v.purport) parts.push(`Purport excerpt: ${v.purport.slice(0, 800)}`);
  return parts.join(" ");
}

function buildProseText(r: any): string {
  const parts: string[] = [];
  parts.push(`[${r.book_slug} - paragraph ${r.paragraph_number}]`);
  if (r.tags?.length) parts.push(`Topics: ${r.tags.join(", ")}.`);
  if (r.body_text) parts.push(`Text: ${r.body_text.slice(0, 1200)}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Process verses
// ---------------------------------------------------------------------------
async function processVerses() {
  console.log("\n=== Processing verses ===\n");

  const allIds = await fetchAllNullIds("verses");
  const total = allIds.length;
  console.log(`Found ${total} verses needing embeddings`);
  if (total === 0) return;

  let done = 0;
  let errors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);

    try {
      // Step 1: Fetch verse data (1 query)
      const { data: verses, error } = await supabase
        .from("verses")
        .select("id, scripture, verse_number, translation, purport, tags, chapter_id")
        .in("id", batchIds);

      if (error || !verses || verses.length === 0) {
        console.error(`  Fetch error:`, error?.message);
        errors += batchIds.length;
        continue;
      }

      // Step 2: Fetch chapter info (1 query)
      const chIds = [...new Set(verses.map((v) => v.chapter_id).filter(Boolean))];
      const chapterMap: Record<string, any> = {};
      if (chIds.length > 0) {
        const { data: chapters } = await supabase
          .from("chapters")
          .select("id, canto_or_division, chapter_number")
          .in("id", chIds);
        if (chapters) for (const c of chapters) chapterMap[c.id] = c;
      }

      // Step 3: Build texts
      const orderedIds: string[] = [];
      const texts: string[] = [];
      for (const v of verses) {
        const ch = chapterMap[v.chapter_id] || { canto_or_division: "?", chapter_number: "?" };
        orderedIds.push(v.id);
        texts.push(buildVerseText(v, ch));
      }

      // Step 4: Batch embed — 1 API call for all texts
      const embeddings = await batchEmbed(texts);

      // Step 5: Batch write — 1 DB call for all embeddings
      const written = await batchWrite("verses", orderedIds, embeddings);
      done += written;
    } catch (err: any) {
      console.error(`  Batch error: ${(err.message || "").substring(0, 120)}`);
      errors += batchIds.length;
    }

    // Progress
    const mins = (Date.now() - startTime) / 60000;
    const rate = mins > 0.1 ? (done / mins).toFixed(0) : "...";
    const eta = mins > 0.1 && done > 0 ? Math.ceil((total - done) / (done / mins)) : "...";
    console.log(
      `  ${done}/${total} (${((done / total) * 100).toFixed(1)}%) | ${errors} err | ${rate}/min | ~${eta}min | ${elapsed()}`
    );

    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log(`\nVerses: ${done} done, ${errors} errors | ${elapsed()}`);
}

// ---------------------------------------------------------------------------
// Process prose
// ---------------------------------------------------------------------------
async function processProse() {
  console.log("\n=== Processing prose_paragraphs ===\n");

  const allIds = await fetchAllNullIds("prose_paragraphs");
  const total = allIds.length;
  console.log(`Found ${total} prose paragraphs needing embeddings`);
  if (total === 0) return;

  let done = 0;
  let errors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);

    try {
      // Step 1: Fetch prose data
      const { data: rows, error } = await supabase
        .from("prose_paragraphs")
        .select("id, book_slug, paragraph_number, body_text, tags")
        .in("id", batchIds);

      if (error || !rows || rows.length === 0) {
        console.error(`  Fetch error:`, error?.message);
        errors += batchIds.length;
        continue;
      }

      // Step 2: Build texts
      const orderedIds: string[] = [];
      const texts: string[] = [];
      for (const r of rows) {
        orderedIds.push(r.id);
        texts.push(buildProseText(r));
      }

      // Step 3: Batch embed
      const embeddings = await batchEmbed(texts);

      // Step 4: Batch write
      const written = await batchWrite("prose_paragraphs", orderedIds, embeddings);
      done += written;
    } catch (err: any) {
      console.error(`  Batch error: ${(err.message || "").substring(0, 120)}`);
      errors += batchIds.length;
    }

    const mins = (Date.now() - startTime) / 60000;
    const rate = mins > 0.1 ? (done / mins).toFixed(0) : "...";
    const eta = mins > 0.1 && done > 0 ? Math.ceil((total - done) / (done / mins)) : "...";
    console.log(
      `  ${done}/${total} (${((done / total) * 100).toFixed(1)}%) | ${errors} err | ${rate}/min | ~${eta}min | ${elapsed()}`
    );

    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log(`\nProse: ${done} done, ${errors} errors | ${elapsed()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Embedding Generation v4 — BATCH MODE ===");
  console.log(`gemini-embedding-2-preview | ${EXPECTED_DIMS}d`);
  console.log(`${BATCH_SIZE} texts per Gemini call | batch DB writes\n`);

  await processVerses();
  await processProse();

  console.log(`\n=== ALL DONE === | ${elapsed()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});