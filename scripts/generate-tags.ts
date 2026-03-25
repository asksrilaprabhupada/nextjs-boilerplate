/**
 * Tag Generation Script (FIXED)
 *
 * Reads verses and prose_paragraphs with empty tags from Supabase,
 * uses Gemini 2.5 Flash to generate rich search tags, and stores them.
 *
 * Usage: npx tsx scripts/generate-tags.ts
 * Test:  npx tsx scripts/generate-tags.ts --test
 * Requires GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "fs";
import { resolve } from "path";

const FAILED_LOG = resolve(__dirname, "..", "failed-verses.log");

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
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
  } catch {
    // .env.local may not exist if env vars are already set
  }
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

// Using gemini-2.5-flash
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;
const TEST_MODE = process.argv.includes("--test");

if (TEST_MODE) {
  console.log("🧪 TEST MODE — processing only 5 rows\n");
}

// ---------------------------------------------------------------------------
// Gemini helper — with responseMimeType: application/json
// ---------------------------------------------------------------------------
async function callGemini(prompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
}

// ---------------------------------------------------------------------------
// Aggressive JSON extraction — handles every edge case
// ---------------------------------------------------------------------------
function extractJSON(raw: string): {
  topics?: string[];
  sanskrit_terms?: string[];
  questions?: string[];
  summary?: string;
} | null {
  if (!raw || raw.trim().length === 0) return null;

  let cleaned = raw.trim();

  // Step 1: Remove markdown code block wrappers
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

  // Step 2: Extract everything between first { and last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  cleaned = cleaned.substring(firstBrace, lastBrace + 1);

  // Step 3: Fix common JSON issues
  // Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  // Step 4: Try parsing
  try {
    return JSON.parse(cleaned);
  } catch {
    // Step 5: Last resort — try to fix escaped quotes and other issues
    try {
      // Replace single quotes with double quotes (risky but sometimes needed)
      const fixed = cleaned.replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Build tags array from parsed JSON
// ---------------------------------------------------------------------------
function buildTags(parsed: {
  topics?: string[];
  sanskrit_terms?: string[];
  questions?: string[];
  summary?: string;
}): string[] {
  const tags: string[] = [];
  if (Array.isArray(parsed.topics)) tags.push(...parsed.topics.filter((t) => typeof t === "string"));
  if (Array.isArray(parsed.sanskrit_terms))
    tags.push(...parsed.sanskrit_terms.filter((t) => typeof t === "string"));
  if (Array.isArray(parsed.questions))
    tags.push(...parsed.questions.filter((t) => typeof t === "string"));
  if (parsed.summary && typeof parsed.summary === "string") tags.push(`SUMMARY: ${parsed.summary}`);
  return tags;
}

// ---------------------------------------------------------------------------
// Process a single verse
// ---------------------------------------------------------------------------
async function processVerse(
  verse: {
    id: string;
    scripture: string;
    verse_number: string;
    translation: string | null;
    purport: string | null;
    chapter_id: string;
  },
  chapterMap: Record<string, { canto_or_division: string; chapter_number: number }>
): Promise<boolean> {
  const ch = chapterMap[verse.chapter_id] || { canto_or_division: "", chapter_number: "" };
  const purportExcerpt = (verse.purport || "").slice(0, 800);

  const prompt = `You are an expert on Śrīla Prabhupāda's teachings and ISKCON devotee culture.

Read this verse and purport from ${verse.scripture} ${ch.canto_or_division || ""}.${ch.chapter_number || ""}.${verse.verse_number}.

Translation: "${verse.translation || "No translation available"}"
Purport (excerpt): "${purportExcerpt || "No purport available"}"

Return a JSON object with these fields:
{
  "topics": ["10-15 English search terms a devotee might type to find this verse"],
  "sanskrit_terms": ["5-8 relevant Sanskrit terms"],
  "questions": ["3-5 questions a devotee might ask that this verse answers"],
  "summary": "1-2 sentence summary of the key teaching"
}`;

  let parsed: ReturnType<typeof extractJSON> = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callGemini(prompt);

    if (TEST_MODE) {
      console.log(`  RAW attempt ${attempt} (first 300 chars): ${raw.substring(0, 300)}`);
    }

    parsed = extractJSON(raw);
    if (parsed) break;

    if (attempt === 1) {
      console.warn(`  ⚠️ Parse failed for verse ${verse.id}, retrying in 2s...`);
      if (!TEST_MODE) {
        console.error(`     Raw response (first 150): ${raw.substring(0, 150)}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.error(`  ❌ Both attempts failed for verse ${verse.id} — logging to failed-verses.log`);
      if (!TEST_MODE) {
        console.error(`     Raw response (first 150): ${raw.substring(0, 150)}`);
      }
      appendFileSync(FAILED_LOG, `verse:${verse.id}\n`);
      return false;
    }
  }

  if (!parsed) {
    appendFileSync(FAILED_LOG, `verse:${verse.id}\n`);
    return false;
  }

  const tags = buildTags(parsed);
  if (tags.length === 0) {
    console.error(`  ❌ Empty tags for verse ${verse.id}`);
    appendFileSync(FAILED_LOG, `verse:${verse.id}:empty_tags\n`);
    return false;
  }

  const { error: updateError } = await supabase.from("verses").update({ tags }).eq("id", verse.id);

  if (updateError) {
    console.error(`  ❌ Update error for verse ${verse.id}: ${updateError.message}`);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Process verses
// ---------------------------------------------------------------------------
async function processVerses() {
  console.log("\n=== Processing verses ===\n");

  // Fetch verse IDs with empty tags
  let allIds: string[] = [];
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("verses")
      .select("id")
      .or("tags.is.null,tags.eq.{}")
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("Error fetching verse IDs:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allIds.push(...data.map((r: { id: string }) => r.id));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // In test mode, only process 5
  if (TEST_MODE) {
    allIds = allIds.slice(0, 5);
  }

  const total = allIds.length;
  console.log(`Found ${total} verses needing tags${TEST_MODE ? " (test mode: 5 only)" : ""}`);
  if (total === 0) return;

  let processed = 0;
  let errors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);

    // Fetch full data for the batch
    const { data: verses, error } = await supabase
      .from("verses")
      .select("id, scripture, verse_number, translation, purport, chapter_id")
      .in("id", batchIds);

    if (error || !verses) {
      console.error(`Error fetching batch at offset ${i}:`, error?.message);
      errors += batchIds.length;
      continue;
    }

    // Get chapter info
    const chapterIds = [...new Set(verses.map((v) => v.chapter_id).filter(Boolean))];
    let chapterMap: Record<string, { canto_or_division: string; chapter_number: number }> = {};
    if (chapterIds.length > 0) {
      const { data: chapters } = await supabase
        .from("chapters")
        .select("id, canto_or_division, chapter_number")
        .in("id", chapterIds);
      if (chapters) {
        for (const c of chapters) {
          chapterMap[c.id] = {
            canto_or_division: c.canto_or_division,
            chapter_number: c.chapter_number,
          };
        }
      }
    }

    // Process each verse SEQUENTIALLY within batch to avoid rate limits
    for (const verse of verses) {
      try {
        const success = await processVerse(verse, chapterMap);
        if (success) {
          processed++;
        } else {
          errors++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Error processing verse ${verse.id}: ${msg}`);
        errors++;
      }
    }

    // Progress log
    const totalDone = processed + errors;
    if (totalDone % 50 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(
        `  ✅ ${processed} / ${total} verses tagged (${pct}%) | ${errors} errors`
      );
    }

    // Delay between batches
    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\n=== Verses complete: ${processed} tagged, ${errors} errors out of ${total} ===`);
}

// ---------------------------------------------------------------------------
// Process prose_paragraphs
// ---------------------------------------------------------------------------
async function processProse() {
  console.log("\n=== Processing prose_paragraphs ===\n");

  let allIds: string[] = [];
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("prose_paragraphs")
      .select("id")
      .or("tags.is.null,tags.eq.{}")
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("Error fetching prose IDs:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allIds.push(...data.map((r: { id: string }) => r.id));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (TEST_MODE) {
    allIds = allIds.slice(0, 5);
  }

  const total = allIds.length;
  console.log(`Found ${total} prose paragraphs needing tags${TEST_MODE ? " (test mode: 5 only)" : ""}`);
  if (total === 0) return;

  let processed = 0;
  let errors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);

    const { data: rows, error } = await supabase
      .from("prose_paragraphs")
      .select("id, book_slug, paragraph_number, body_text, chapter_id")
      .in("id", batchIds);

    if (error || !rows) {
      console.error(`Error fetching prose batch at offset ${i}:`, error?.message);
      errors += batchIds.length;
      continue;
    }

    for (const row of rows) {
      try {
        const textExcerpt = (row.body_text || "").slice(0, 800);
        const prompt = `You are an expert on Śrīla Prabhupāda's teachings and ISKCON devotee culture.

Read this paragraph from "${row.book_slug}", paragraph ${row.paragraph_number}.

Text (excerpt): "${textExcerpt}"

Return a JSON object with these fields:
{
  "topics": ["10-15 English search terms a devotee might type to find this passage"],
  "sanskrit_terms": ["5-8 relevant Sanskrit terms"],
  "questions": ["3-5 questions a devotee might ask that this passage answers"],
  "summary": "1-2 sentence summary of the key teaching"
}`;

        let parsed: ReturnType<typeof extractJSON> = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
          const raw = await callGemini(prompt);

          if (TEST_MODE) {
            console.log(`  RAW attempt ${attempt} (first 300 chars): ${raw.substring(0, 300)}`);
          }

          parsed = extractJSON(raw);
          if (parsed) break;

          if (attempt === 1) {
            console.warn(`  ⚠️ Parse failed for prose ${row.id}, retrying in 2s...`);
            if (!TEST_MODE) {
              console.error(`     Raw (first 150): ${raw.substring(0, 150)}`);
            }
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            console.error(`  ❌ Both attempts failed for prose ${row.id} — logging to failed-verses.log`);
            if (!TEST_MODE) {
              console.error(`     Raw (first 150): ${raw.substring(0, 150)}`);
            }
            appendFileSync(FAILED_LOG, `prose:${row.id}\n`);
            errors++;
            continue;
          }
        }

        if (!parsed) {
          errors++;
          continue;
        }

        const tags = buildTags(parsed);
        if (tags.length === 0) {
          console.error(`  ❌ Empty tags for prose ${row.id}`);
          appendFileSync(FAILED_LOG, `prose:${row.id}:empty_tags\n`);
          errors++;
          continue;
        }

        const { error: updateError } = await supabase
          .from("prose_paragraphs")
          .update({ tags })
          .eq("id", row.id);

        if (updateError) {
          console.error(`  ❌ Update error for prose ${row.id}: ${updateError.message}`);
          errors++;
          continue;
        }

        processed++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Error processing prose ${row.id}: ${msg}`);
        errors++;
      }
    }

    const totalDone = processed + errors;
    if (totalDone % 50 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(
        `  ✅ ${processed} / ${total} prose tagged (${pct}%) | ${errors} errors`
      );
    }

    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\n=== Prose complete: ${processed} tagged, ${errors} errors out of ${total} ===`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Tag Generation Script (FIXED) ===");
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Batch size: ${BATCH_SIZE}, Delay: ${BATCH_DELAY_MS}ms`);
  console.log(`responseMimeType: application/json (forces clean JSON output)\n`);

  await processVerses();

  if (!TEST_MODE) {
    await processProse();
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});