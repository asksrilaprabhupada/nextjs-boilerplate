/**
 * 03-verify-urls.ts — Vedabase URL Verification Script
 *
 * Validates every vedabase_url in verses and prose_paragraphs tables
 * by making HTTP HEAD requests to Vedabase.io, then updates the
 * vedabase_url_status column: 'verified', 'broken', or 'redirect'.
 *
 * For broken URLs, attempts to find the correct URL by testing
 * common Vedabase URL patterns and fixes them in-place.
 *
 * Usage:
 *   npx tsx scripts/03-verify-urls.ts                  # verify all
 *   npx tsx scripts/03-verify-urls.ts --verses-only    # verses only
 *   npx tsx scripts/03-verify-urls.ts --prose-only     # prose only
 *   npx tsx scripts/03-verify-urls.ts --broken-only    # re-check broken ones
 *   npx tsx scripts/03-verify-urls.ts --test           # test with 10 rows
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ─── ENV ────────────────────────────────────────────────────────────────────

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

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;
const CONCURRENCY = 5;           // parallel HTTP requests
const DELAY_BETWEEN_BATCHES = 500; // ms — be polite to Vedabase
const HTTP_TIMEOUT = 10_000;      // 10s per request
const REPORT_PATH = resolve(__dirname, "..", "url-verification-report.json");
const LOG_PATH = resolve(__dirname, "..", "url-verification.log");

const TEST_MODE = process.argv.includes("--test");
const VERSES_ONLY = process.argv.includes("--verses-only");
const PROSE_ONLY = process.argv.includes("--prose-only");
const BROKEN_ONLY = process.argv.includes("--broken-only");

const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 60000).toFixed(1) + "m";

// ─── STATS ──────────────────────────────────────────────────────────────────

interface Stats {
  total: number;
  verified: number;
  broken: number;
  redirect: number;
  errors: number;
  fixed: number;
}

const stats: { verses: Stats; prose: Stats } = {
  verses: { total: 0, verified: 0, broken: 0, redirect: 0, errors: 0, fixed: 0 },
  prose: { total: 0, verified: 0, broken: 0, redirect: 0, errors: 0, fixed: 0 },
};

const brokenLog: Array<{
  table: string;
  id: string;
  url: string;
  status: number;
  redirect_url?: string;
}> = [];

// ─── HTTP CHECK ─────────────────────────────────────────────────────────────

interface CheckResult {
  status: "verified" | "broken" | "redirect";
  httpCode: number;
  redirectUrl?: string;
}

async function checkUrl(url: string): Promise<CheckResult> {
  // Strip text fragment for HTTP check (browsers handle #:~:text= client-side)
  const cleanUrl = url.split("#")[0];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const res = await fetch(cleanUrl, {
      method: "HEAD",
      redirect: "manual", // Don't follow redirects — we want to see them
      signal: controller.signal,
      headers: {
        "User-Agent": "AskSrilaPrabhupada-URLVerifier/1.0",
      },
    });

    clearTimeout(timeout);

    if (res.status >= 200 && res.status < 300) {
      return { status: "verified", httpCode: res.status };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") || "";
      return { status: "redirect", httpCode: res.status, redirectUrl: location };
    }

    // 404, 500, etc
    return { status: "broken", httpCode: res.status };
  } catch (err: any) {
    clearTimeout(timeout);

    // HEAD might be blocked — try GET as fallback
    try {
      const res2 = await fetch(cleanUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
        headers: {
          "User-Agent": "AskSrilaPrabhupada-URLVerifier/1.0",
        },
      });

      if (res2.status >= 200 && res2.status < 300) {
        return { status: "verified", httpCode: res2.status };
      }
      if (res2.status >= 300 && res2.status < 400) {
        return { status: "redirect", httpCode: res2.status, redirectUrl: res2.headers.get("location") || "" };
      }
      return { status: "broken", httpCode: res2.status };
    } catch {
      return { status: "broken", httpCode: 0 };
    }
  }
}

// ─── URL FIX ATTEMPTS ───────────────────────────────────────────────────────

/**
 * For broken verse URLs, try common Vedabase URL variations.
 * E.g., range "11-13" might need to be "11" on Vedabase.
 */
function generateVerseFixes(url: string, verseNumber: string): string[] {
  const fixes: string[] = [];
  const base = url.replace(/[^/]+\/$/, ""); // strip last segment

  // If verse is a range like "11-13", try just the first number
  if (verseNumber.includes("-")) {
    const first = verseNumber.split("-")[0];
    fixes.push(base + first + "/");
  }

  // If verse has "Text " prefix still somehow
  if (verseNumber.startsWith("Text ")) {
    const num = verseNumber.replace("Text ", "");
    fixes.push(base + num + "/");
  }

  // Try without trailing slash
  fixes.push(url.replace(/\/$/, ""));

  return fixes;
}

// ─── PROCESS IN PARALLEL ────────────────────────────────────────────────────

async function processInParallel<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

// ─── VERIFY VERSES ──────────────────────────────────────────────────────────

async function verifyVerses() {
  console.log("\n=== Verifying Verse URLs ===\n");

  // Fetch IDs to verify
  let query = supabase
    .from("verses")
    .select("id, vedabase_url, verse_number, scripture")
    .not("vedabase_url", "eq", "")
    .not("vedabase_url", "is", null);

  if (BROKEN_ONLY) {
    query = query.eq("vedabase_url_status", "broken");
  } else {
    query = query.in("vedabase_url_status", ["generated", "broken"]);
  }

  query = query.order("scripture").limit(TEST_MODE ? 10 : 50000);

  const { data: rows, error } = await query;
  if (error || !rows) {
    console.error("Failed to fetch verses:", error?.message);
    return;
  }

  stats.verses.total = rows.length;
  console.log(`Found ${rows.length} verse URLs to verify\n`);
  if (rows.length === 0) return;

  let processed = 0;

  // Process in batches
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await processInParallel(batch, CONCURRENCY, async (row) => {
      const result = await checkUrl(row.vedabase_url);
      const now = new Date().toISOString();

      if (result.status === "verified") {
        stats.verses.verified++;
        await supabase
          .from("verses")
          .update({ vedabase_url_status: "verified", vedabase_url_verified_at: now })
          .eq("id", row.id);
      } else if (result.status === "redirect") {
        stats.verses.redirect++;

        // If redirect gives us a valid URL, use it
        if (result.redirectUrl && result.redirectUrl.includes("vedabase.io")) {
          await supabase
            .from("verses")
            .update({
              vedabase_url: result.redirectUrl.endsWith("/") ? result.redirectUrl : result.redirectUrl + "/",
              vedabase_url_status: "verified",
              vedabase_url_verified_at: now,
            })
            .eq("id", row.id);
          stats.verses.fixed++;
        } else {
          await supabase
            .from("verses")
            .update({ vedabase_url_status: "redirect", vedabase_url_verified_at: now })
            .eq("id", row.id);
        }

        brokenLog.push({ table: "verses", id: row.id, url: row.vedabase_url, status: result.httpCode, redirect_url: result.redirectUrl });
      } else {
        // Broken — try fixes
        let fixed = false;
        const fixes = generateVerseFixes(row.vedabase_url, row.verse_number);

        for (const fixUrl of fixes) {
          const fixResult = await checkUrl(fixUrl);
          if (fixResult.status === "verified") {
            await supabase
              .from("verses")
              .update({
                vedabase_url: fixUrl.endsWith("/") ? fixUrl : fixUrl + "/",
                vedabase_url_status: "verified",
                vedabase_url_verified_at: now,
              })
              .eq("id", row.id);
            stats.verses.fixed++;
            stats.verses.verified++;
            fixed = true;
            break;
          }
        }

        if (!fixed) {
          stats.verses.broken++;
          await supabase
            .from("verses")
            .update({ vedabase_url_status: "broken", vedabase_url_verified_at: now })
            .eq("id", row.id);
          brokenLog.push({ table: "verses", id: row.id, url: row.vedabase_url, status: result.httpCode });
        }
      }

      processed++;
    });

    // Progress
    const pct = ((processed / rows.length) * 100).toFixed(1);
    const v = stats.verses;
    console.log(
      `  ${processed}/${rows.length} (${pct}%) | ✓ ${v.verified} | ✗ ${v.broken} | → ${v.redirect} | 🔧 ${v.fixed} | ${elapsed()}`
    );

    if (i + BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  console.log(`\nVerses done: ✓ ${stats.verses.verified} verified, ✗ ${stats.verses.broken} broken, 🔧 ${stats.verses.fixed} auto-fixed | ${elapsed()}`);
}

// ─── VERIFY PROSE ───────────────────────────────────────────────────────────

async function verifyProse() {
  console.log("\n=== Verifying Prose URLs ===\n");

  // For prose, we verify the chapter-level URL (the base)
  // The text fragment (#:~:text=) is client-side only and can't be verified via HTTP

  let query = supabase
    .from("prose_paragraphs")
    .select("id, vedabase_url, vedabase_url_precise, book_slug, paragraph_number")
    .not("vedabase_url", "eq", "")
    .not("vedabase_url", "is", null);

  if (BROKEN_ONLY) {
    query = query.eq("vedabase_url_status", "broken");
  } else {
    query = query.in("vedabase_url_status", ["generated", "broken"]);
  }

  query = query.order("book_slug").limit(TEST_MODE ? 10 : 50000);

  const { data: rows, error } = await query;
  if (error || !rows) {
    console.error("Failed to fetch prose:", error?.message);
    return;
  }

  stats.prose.total = rows.length;
  console.log(`Found ${rows.length} prose URLs to verify\n`);
  if (rows.length === 0) return;

  // Prose optimization: many paragraphs share the same chapter URL.
  // Verify each unique URL only once, then batch-update all rows.
  const urlToIds = new Map<string, string[]>();
  for (const row of rows) {
    const base = row.vedabase_url;
    if (!urlToIds.has(base)) urlToIds.set(base, []);
    urlToIds.get(base)!.push(row.id);
  }

  const uniqueUrls = [...urlToIds.keys()];
  console.log(`  ${uniqueUrls.length} unique chapter-level URLs to check (from ${rows.length} paragraphs)\n`);

  let processed = 0;

  for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
    const batch = uniqueUrls.slice(i, i + BATCH_SIZE);

    await processInParallel(batch, CONCURRENCY, async (url) => {
      const result = await checkUrl(url);
      const now = new Date().toISOString();
      const ids = urlToIds.get(url) || [];

      let status: "verified" | "broken" | "redirect" = result.status;

      if (result.status === "redirect" && result.redirectUrl?.includes("vedabase.io")) {
        // Follow the redirect — use the new URL
        const newBase = result.redirectUrl.endsWith("/") ? result.redirectUrl : result.redirectUrl + "/";

        // Update all paragraphs that shared this URL
        for (let j = 0; j < ids.length; j += 100) {
          const chunk = ids.slice(j, j + 100);
          await supabase
            .from("prose_paragraphs")
            .update({
              vedabase_url: newBase,
              vedabase_url_status: "verified",
              vedabase_url_verified_at: now,
            })
            .in("id", chunk);
        }

        stats.prose.verified += ids.length;
        stats.prose.fixed += ids.length;
        status = "verified";
      } else if (result.status === "verified") {
        for (let j = 0; j < ids.length; j += 100) {
          const chunk = ids.slice(j, j + 100);
          await supabase
            .from("prose_paragraphs")
            .update({
              vedabase_url_status: "verified",
              vedabase_url_verified_at: now,
            })
            .in("id", chunk);
        }
        stats.prose.verified += ids.length;
      } else {
        for (let j = 0; j < ids.length; j += 100) {
          const chunk = ids.slice(j, j + 100);
          await supabase
            .from("prose_paragraphs")
            .update({
              vedabase_url_status: "broken",
              vedabase_url_verified_at: now,
            })
            .in("id", chunk);
        }
        stats.prose.broken += ids.length;
        brokenLog.push({ table: "prose_paragraphs", id: ids[0], url, status: result.httpCode });
      }

      processed++;
    });

    const pct = ((processed / uniqueUrls.length) * 100).toFixed(1);
    const p = stats.prose;
    console.log(
      `  ${processed}/${uniqueUrls.length} URLs (${pct}%) | ✓ ${p.verified} rows | ✗ ${p.broken} rows | 🔧 ${p.fixed} rows | ${elapsed()}`
    );

    if (i + BATCH_SIZE < uniqueUrls.length) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  console.log(`\nProse done: ✓ ${stats.prose.verified} verified, ✗ ${stats.prose.broken} broken, 🔧 ${stats.prose.fixed} auto-fixed | ${elapsed()}`);
}

// ─── REPORT ─────────────────────────────────────────────────────────────────

function writeReport() {
  const report = {
    generated_at: new Date().toISOString(),
    duration: elapsed(),
    summary: {
      verses: stats.verses,
      prose: stats.prose,
    },
    broken_urls: brokenLog,
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${REPORT_PATH}`);

  if (brokenLog.length > 0) {
    const logLines = brokenLog.map(
      (b) => `[${b.table}] ${b.id} | ${b.status} | ${b.url}${b.redirect_url ? ` → ${b.redirect_url}` : ""}`
    );
    appendFileSync(LOG_PATH, "\n--- " + new Date().toISOString() + " ---\n" + logLines.join("\n") + "\n");
    console.log(`Broken URLs logged: ${LOG_PATH}`);
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Vedabase URL Verification ===");
  console.log(`Mode: ${TEST_MODE ? "TEST (10 rows)" : "FULL"}`);
  console.log(`Scope: ${VERSES_ONLY ? "verses only" : PROSE_ONLY ? "prose only" : "all"}`);
  console.log(`Concurrency: ${CONCURRENCY} | Batch: ${BATCH_SIZE}\n`);

  if (!PROSE_ONLY) await verifyVerses();
  if (!VERSES_ONLY) await verifyProse();

  writeReport();

  console.log("\n=== SUMMARY ===");
  console.log(`Verses: ✓ ${stats.verses.verified} | ✗ ${stats.verses.broken} | 🔧 ${stats.verses.fixed}`);
  console.log(`Prose:  ✓ ${stats.prose.verified} | ✗ ${stats.prose.broken} | 🔧 ${stats.prose.fixed}`);
  console.log(`Total broken: ${brokenLog.length}`);
  console.log(`Time: ${elapsed()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});