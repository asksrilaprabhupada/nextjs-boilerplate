/**
 * FAST Embedding Generation Script
 *
 * Parallelized version — processes 100 embeddings concurrently.
 * Paid tier supports 2000+ RPM for embedding models.
 *
 * Usage: npx tsx scripts/generate-embeddings.ts
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

const EMBEDDING_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent";
const EXPECTED_DIMS = 1536;

// ⚡ SPEED SETTINGS — paid tier supports 2000+ RPM for embeddings
const BATCH_SIZE = 100;        // fetch 100 rows per batch from Supabase
const CONCURRENCY = 80;        // fire 80 embedding requests in parallel
const BATCH_DELAY_MS = 300;    // short pause between batches
const MAX_RETRIES = 3;         // retry transient errors (503, 429)
const RETRY_DELAY_MS = 2000;   // wait before retry

const startTime = Date.now();

function elapsed(): string {
  return ((Date.now() - startTime) / 60000).toFixed(1) + "m";
}

// ---------------------------------------------------------------------------
// Embedding helper with retry
// ---------------------------------------------------------------------------
async function getEmbedding(text: string, retries = MAX_RETRIES): Promise<number[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${EMBEDDING_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: EXPECTED_DIMS,
          taskType: "RETRIEVAL_DOCUMENT",
        }),
      });

      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          const wait = RETRY_DELAY_MS * attempt; // exponential-ish backoff
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Embedding API error ${res.status}: ${body.substring(0, 200)}`);
      }

      const data = await res.json();
      const values: number[] = data?.embedding?.values ?? [];

      if (values.length !== EXPECTED_DIMS) {
        throw new Error(`Expected ${EXPECTED_DIMS} dimensions, got ${values.length}`);
      }

      return values;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Build rich text for a verse
// ---------------------------------------------------------------------------
function buildVerseText(verse: {
  scripture: string;
  verse_number: string;
  translation: string | null;
  purport: string | null;
  tags: string[] | null;
  canto: string;
  chapter: number | string;
}): string {
  const parts: string[] = [];
  parts.push(`[${verse.scripture} ${verse.canto}.${verse.chapter}.${verse.verse_number}]`);

  if (verse.tags && verse.tags.length > 0) {
    parts.push(`Topics: ${verse.tags.join(", ")}.`);
  }

  if (verse.translation) {
    parts.push(`Translation: ${verse.translation}.`);
  }

  if (verse.purport) {
    parts.push(`Purport excerpt: ${verse.purport.slice(0, 800)}`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Build rich text for a prose paragraph
// ---------------------------------------------------------------------------
function buildProseText(row: {
  book_slug: string;
  paragraph_number: number;
  body_text: string | null;
  tags: string[] | null;
}): string {
  const parts: string[] = [];
  parts.push(`[${row.book_slug} - paragraph ${row.paragraph_number}]`);

  if (row.tags && row.tags.length > 0) {
    parts.push(`Topics: ${row.tags.join(", ")}.`);
  }

  if (row.body_text) {
    parts.push(`Text: ${row.body_text.slice(0, 1200)}`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Process a chunk of items in parallel with concurrency limit
// ---------------------------------------------------------------------------
async function processInParallel<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<boolean>
): Promise<{ success: number; errors: number }> {
  let success = 0;
  let errors = 0;
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      const ok = await fn(items[i]);
      if (ok) success++;
      else errors++;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return { success, errors };
}

// ---------------------------------------------------------------------------
// Process verses
// ---------------------------------------------------------------------------
async function processVerses() {
  console.log("\n=== Processing verses ===\n");

  // Collect all IDs with NULL embedding
  let allIds: string[] = [];
  let from = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("verses")
      .select("id")
      .is("embedding", null)
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
  console.log(`Found ${total} verses needing embeddings`);
  if (total === 0) return;

  let totalProcessed = 0;
  let totalErrors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);

    const { data: verses, error } = await supabase
      .from("verses")
      .select("id, scripture, verse_number, translation, purport, tags, chapter_id")
      .in("id", batchIds);

    if (error || !verses) {
      console.error(`Error fetching verse batch at offset ${i}:`, error?.message);
      totalErrors += batchIds.length;
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
          chapterMap[c.id] = { canto_or_division: c.canto_or_division, chapter_number: c.chapter_number };
        }
      }
    }

    // ⚡ Process all verses in this batch IN PARALLEL
    const { success, errors } = await processInParallel(verses, CONCURRENCY, async (verse) => {
      try {
        const ch = chapterMap[verse.chapter_id] || { canto_or_division: "?", chapter_number: "?" };
        const richText = buildVerseText({
          scripture: verse.scripture,
          verse_number: verse.verse_number,
          translation: verse.translation,
          purport: verse.purport,
          tags: verse.tags,
          canto: ch.canto_or_division,
          chapter: ch.chapter_number,
        });

        const embedding = await getEmbedding(richText);

        const { error: updateError } = await supabase
          .from("verses")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", verse.id);

        if (updateError) {
          console.error(`  Update error for verse ${verse.id}:`, updateError.message);
          return false;
        }

        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("503") && !msg.includes("429")) {
          console.error(`  Error embedding verse ${verse.id}: ${msg.substring(0, 150)}`);
        }
        return false;
      }
    });

    totalProcessed += success;
    totalErrors += errors;

    // Progress log
    const done = totalProcessed + totalErrors;
    const mins = (Date.now() - startTime) / 60000;
    const rate = mins > 0.1 ? (totalProcessed / mins).toFixed(0) : "...";
    const remaining = mins > 0.1 && totalProcessed > 0
      ? Math.ceil((total - totalProcessed) / (totalProcessed / mins))
      : "...";

    if (done % 200 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      console.log(
        `  ${totalProcessed} / ${total} (${((totalProcessed / total) * 100).toFixed(1)}%) ` +
        `| ${totalErrors} err | ${rate}/min | ~${remaining} min left | ${elapsed()}`
      );
    }

    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nVerses complete: ${totalProcessed} embedded, ${totalErrors} errors out of ${total} | ${elapsed()}`);
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
      .is("embedding", null)
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
  console.log(`Found ${total} prose paragraphs needing embeddings`);
  if (total === 0) return;

  let totalProcessed = 0;
  let totalErrors = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);

    const { data: rows, error } = await supabase
      .from("prose_paragraphs")
      .select("id, book_slug, paragraph_number, body_text, tags")
      .in("id", batchIds);

    if (error || !rows) {
      console.error(`Error fetching prose batch at offset ${i}:`, error?.message);
      totalErrors += batchIds.length;
      continue;
    }

    // ⚡ Process all prose in this batch IN PARALLEL
    const { success, errors } = await processInParallel(rows, CONCURRENCY, async (row) => {
      try {
        const richText = buildProseText({
          book_slug: row.book_slug,
          paragraph_number: row.paragraph_number,
          body_text: row.body_text,
          tags: row.tags,
        });

        const embedding = await getEmbedding(richText);

        const { error: updateError } = await supabase
          .from("prose_paragraphs")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", row.id);

        if (updateError) {
          console.error(`  Update error for prose ${row.id}:`, updateError.message);
          return false;
        }

        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("503") && !msg.includes("429")) {
          console.error(`  Error embedding prose ${row.id}: ${msg.substring(0, 150)}`);
        }
        return false;
      }
    });

    totalProcessed += success;
    totalErrors += errors;

    const done = totalProcessed + totalErrors;
    const mins = (Date.now() - startTime) / 60000;
    const rate = mins > 0.1 ? (totalProcessed / mins).toFixed(0) : "...";
    const remaining = mins > 0.1 && totalProcessed > 0
      ? Math.ceil((total - totalProcessed) / (totalProcessed / mins))
      : "...";

    if (done % 200 < BATCH_SIZE || i + BATCH_SIZE >= allIds.length) {
      console.log(
        `  ${totalProcessed} / ${total} (${((totalProcessed / total) * 100).toFixed(1)}%) ` +
        `| ${totalErrors} err | ${rate}/min | ~${remaining} min left | ${elapsed()}`
      );
    }

    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nProse complete: ${totalProcessed} embedded, ${totalErrors} errors out of ${total} | ${elapsed()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== ⚡ FAST Embedding Generation Script ===");
  console.log(`Model: gemini-embedding-2-preview, Dimensions: ${EXPECTED_DIMS}`);
  console.log(`Batch: ${BATCH_SIZE}, Concurrency: ${CONCURRENCY}, Retries: ${MAX_RETRIES}\n`);

  await processVerses();
  await processProse();

  console.log(`\n=== Done === | Total time: ${elapsed()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});