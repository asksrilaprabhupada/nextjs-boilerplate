/**
 * Tag Generation Script
 *
 * Reads verses and prose_paragraphs with empty tags from Supabase,
 * uses Gemini 2.0 Flash to generate rich search tags, and stores them.
 *
 * Usage: npx tsx scripts/generate-tags.ts
 * Requires GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required env vars: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const BATCH_SIZE = 15;
const BATCH_DELAY_MS = 1500;

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------
async function callGemini(prompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
}

// ---------------------------------------------------------------------------
// Parse JSON from Gemini response (handles markdown code blocks)
// ---------------------------------------------------------------------------
function parseGeminiJson(raw: string): {
  topics?: string[];
  sanskrit_terms?: string[];
  questions?: string[];
  summary?: string;
} | null {
  let cleaned = raw.trim();
  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from the text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
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
  if (Array.isArray(parsed.topics)) tags.push(...parsed.topics);
  if (Array.isArray(parsed.sanskrit_terms)) tags.push(...parsed.sanskrit_terms);
  if (Array.isArray(parsed.questions)) tags.push(...parsed.questions);
  if (parsed.summary) tags.push(`SUMMARY: ${parsed.summary}`);
  return tags;
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

  const total = allIds.length;
  console.log(`Found ${total} verses needing tags`);
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

    // Get chapter info for canto/chapter numbers
    const chapterIds = [...new Set(verses.map((v) => v.chapter_id).filter(Boolean))];
    let chapterMap: Record<string, { canto_or_division: string; chapter_number: number }> = {};
    if (chapterIds.length > 0) {
      const { data: chapters } = await supabase
        .from("chapters")
        .select("id, canto_or_division, chapter_number")
        .in("id", chapterIds);
      if (chapters) {
        for (const c of chapters) {
          chapterMap[c.id] = { canto_or_division: c.canto_or_division, chapter_number: c.chapter_number };
        }
      }
    }

    // Process each verse in the batch
    const promises = verses.map(async (verse) => {
      try {
        const ch = chapterMap[verse.chapter_id] || { canto_or_division: "?", chapter_number: "?" };
        const purportExcerpt = (verse.purport || "").slice(0, 800);
        const prompt = `You are an expert on Śrīla Prabhupāda's teachings and ISKCON devotee culture.

Read this verse and purport from ${verse.scripture} ${ch.canto_or_division}.${ch.chapter_number}.${verse.verse_number}.

Translation: "${verse.translation || ""}"
Purport (excerpt): "${purportExcerpt}"

Return ONLY a JSON object with these fields:
{
  "topics": ["10-15 English search terms a devotee might type to find this verse — include practical life topics, philosophical concepts, emotional states, daily practices"],
  "sanskrit_terms": ["5-8 relevant Sanskrit terms with and without diacritics, e.g. both 'karma' and 'brahma-muhurta' and 'brahma-muhūrta'"],
  "questions": ["3-5 questions a devotee might ask that this verse answers, e.g. 'How to control the mind?', 'What happens after death?'"],
  "summary": "1-2 sentence summary of the key teaching in this verse and purport"
}

No explanation. Only valid JSON.`;

        const raw = await callGemini(prompt);
        const parsed = parseGeminiJson(raw);
        if (!parsed) {
          console.error(`  Failed to parse JSON for verse ${verse.id}`);
          errors++;
          return;
        }

        const tags = buildTags(parsed);
        if (tags.length === 0) {
          console.error(`  Empty tags for verse ${verse.id}`);
          errors++;
          return;
        }

        const { error: updateError } = await supabase
          .from("verses")
          .update({ tags })
          .eq("id", verse.id);

        if (updateError) {
          console.error(`  Update error for verse ${verse.id}:`, updateError.message);
          errors++;
          return;
        }

        processed++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error processing verse ${verse.id}: ${msg}`);
        errors++;
      }
    });

    await Promise.all(promises);

    if ((processed + errors) % 50 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      console.log(`  Generated tags for ${processed} / ${total} verses (${errors} errors)`);
    }

    // Delay between batches
    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nVerses complete: ${processed} tagged, ${errors} errors out of ${total}`);
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

  const total = allIds.length;
  console.log(`Found ${total} prose paragraphs needing tags`);
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

    const promises = rows.map(async (row) => {
      try {
        const textExcerpt = (row.body_text || "").slice(0, 800);
        const prompt = `You are an expert on Śrīla Prabhupāda's teachings and ISKCON devotee culture.

Read this paragraph from "${row.book_slug}", paragraph ${row.paragraph_number}.

Text (excerpt): "${textExcerpt}"

Return ONLY a JSON object with these fields:
{
  "topics": ["10-15 English search terms a devotee might type to find this passage — include practical life topics, philosophical concepts, emotional states, daily practices"],
  "sanskrit_terms": ["5-8 relevant Sanskrit terms with and without diacritics"],
  "questions": ["3-5 questions a devotee might ask that this passage answers"],
  "summary": "1-2 sentence summary of the key teaching in this passage"
}

No explanation. Only valid JSON.`;

        const raw = await callGemini(prompt);
        const parsed = parseGeminiJson(raw);
        if (!parsed) {
          console.error(`  Failed to parse JSON for prose ${row.id}`);
          errors++;
          return;
        }

        const tags = buildTags(parsed);
        if (tags.length === 0) {
          console.error(`  Empty tags for prose ${row.id}`);
          errors++;
          return;
        }

        const { error: updateError } = await supabase
          .from("prose_paragraphs")
          .update({ tags })
          .eq("id", row.id);

        if (updateError) {
          console.error(`  Update error for prose ${row.id}:`, updateError.message);
          errors++;
          return;
        }

        processed++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error processing prose ${row.id}: ${msg}`);
        errors++;
      }
    });

    await Promise.all(promises);

    if ((processed + errors) % 50 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      console.log(`  Generated tags for ${processed} / ${total} prose paragraphs (${errors} errors)`);
    }

    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nProse complete: ${processed} tagged, ${errors} errors out of ${total}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Tag Generation Script ===");
  console.log(`Batch size: ${BATCH_SIZE}, Delay: ${BATCH_DELAY_MS}ms\n`);

  await processVerses();
  await processProse();

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
