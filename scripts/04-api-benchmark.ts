/**
 * 04-api-benchmark.ts — API-Level Benchmark
 *
 * Reads 300 test queries from the benchmark_queries table in Supabase,
 * sends each to the /api/search endpoint, checks if expected references
 * appear in results, and prints a score card.
 *
 * Usage:
 *   npx tsx scripts/04-api-benchmark.ts                              # test against localhost:3000
 *   npx tsx scripts/04-api-benchmark.ts https://asksrilaprabhupada.com  # test against production
 *   npx tsx scripts/04-api-benchmark.ts --category=exact_reference     # test one category only
 *
 * Prerequisites:
 *   1. npm run dev (in another terminal) — unless testing production
 *   2. .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// ─── Load .env.local ────────────────────────────────────────────────────────

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
  console.error("ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Config ─────────────────────────────────────────────────────────────────

// First argument can be a URL to test against
const args = process.argv.slice(2);
const urlArg = args.find(a => a.startsWith("http"));
const categoryArg = args.find(a => a.startsWith("--category="))?.split("=")[1] || null;

const BASE_URL = urlArg || "http://localhost:3000";
const SEARCH_ENDPOINT = `${BASE_URL}/api/search`;
const DELAY_BETWEEN_QUERIES = 1500; // ms — don't hammer the server
const TIMEOUT_MS = 30000; // 30 seconds per query
const REPORT_PATH = resolve(__dirname, "..", "benchmark-results.json");

const startTime = Date.now();
const elapsed = () => ((Date.now() - startTime) / 60000).toFixed(1) + "m";

// ─── Types ──────────────────────────────────────────────────────────────────

interface BenchmarkQuery {
  id: string;
  query: string;
  category: string;
  difficulty: string;
  expected_references: string[];  // e.g. ["BG 2.13", "BG 2.20"]
  expected_books?: string[];       // e.g. ["bg", "sb"]
  min_results?: number;
}

interface QueryResult {
  query: string;
  category: string;
  difficulty: string;
  passed: boolean;
  expected: string[];
  found: string[];
  matched: string[];
  missing: string[];
  totalResults: number;
  durationMs: number;
  error?: string;
}

// ─── Fetch benchmark queries from Supabase ──────────────────────────────────

async function fetchBenchmarkQueries(): Promise<BenchmarkQuery[]> {
  let query = supabase
    .from("benchmark_queries")
    .select("*")
    .order("category");

  if (categoryArg) {
    query = query.eq("category", categoryArg);
  }

  const { data, error } = await query;

  if (error) {
    console.error("ERROR: Could not read benchmark_queries table:", error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.error("ERROR: No benchmark queries found in the table.");
    if (categoryArg) console.error(`  (You filtered by category="${categoryArg}" — is that correct?)`);
    process.exit(1);
  }

  return data as BenchmarkQuery[];
}

// ─── Call the search API ────────────────────────────────────────────────────

async function callSearchAPI(query: string): Promise<{
  totalResults: number;
  references: string[];
  books: string[];
  durationMs: number;
  error?: string;
}> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Use mode=references and stream=false for faster responses (skip Gemini synthesis)
    const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&mode=references&stream=false`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        totalResults: 0,
        references: [],
        books: [],
        durationMs: Date.now() - start,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();
    const durationMs = Date.now() - start;

    // Extract all verse references from the response
    const references: string[] = [];
    const books: string[] = [];

    if (data.books && Array.isArray(data.books)) {
      for (const book of data.books) {
        if (book.slug) books.push(book.slug.toLowerCase());

        // Extract verse references
        if (book.verses && Array.isArray(book.verses)) {
          for (const v of book.verses) {
            const scripture = v.scripture || "";
            const canto = v.canto_or_division || "";
            const chapter = v.chapter_number || "";
            const verse = (v.verse_number || "").replace(/^Text\s+/i, "");

            let ref = scripture;
            if (canto) ref += ` ${canto}`;
            if (chapter) ref += `.${chapter}`;
            if (verse) ref += `.${verse}`;

            references.push(ref.trim());
          }
        }

        // Also note prose/transcript/letter presence
        if (book.prose?.length > 0) books.push(book.slug?.toLowerCase() || "");
        if (book.transcripts?.length > 0) books.push("lectures");
        if (book.letters?.length > 0) books.push("letters");
      }
    }

    // Also check overflow results
    if (data.overflowVerses && Array.isArray(data.overflowVerses)) {
      for (const v of data.overflowVerses) {
        const scripture = v.scripture || "";
        const canto = v.canto_or_division || "";
        const chapter = v.chapter_number || "";
        const verse = (v.verse_number || "").replace(/^Text\s+/i, "");

        let ref = scripture;
        if (canto) ref += ` ${canto}`;
        if (chapter) ref += `.${chapter}`;
        if (verse) ref += `.${verse}`;

        references.push(ref.trim());
      }
    }

    return {
      totalResults: data.totalResults || 0,
      references: [...new Set(references)],
      books: [...new Set(books.filter(Boolean))],
      durationMs,
    };
  } catch (err: any) {
    return {
      totalResults: 0,
      references: [],
      books: [],
      durationMs: Date.now() - start,
      error: err.name === "AbortError" ? "TIMEOUT (30s)" : err.message,
    };
  }
}

// ─── Check if expected references are found ─────────────────────────────────

function normalizeRef(ref: string): string {
  return ref
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/TEXT\s+/i, "");
}

function checkResult(
  expected: string[],
  found: string[],
  query: BenchmarkQuery,
): { passed: boolean; matched: string[]; missing: string[] } {
  if (!expected || expected.length === 0) {
    // No specific references expected — just check we got some results
    return {
      passed: found.length > 0,
      matched: [],
      missing: [],
    };
  }

  const normalizedFound = new Set(found.map(normalizeRef));
  const matched: string[] = [];
  const missing: string[] = [];

  for (const exp of expected) {
    const normalizedExp = normalizeRef(exp);

    // Check for exact match
    if (normalizedFound.has(normalizedExp)) {
      matched.push(exp);
      continue;
    }

    // Check for partial match (e.g., "BG 2" matches "BG 2.13")
    // This handles cases where expected is a chapter reference
    const partialMatch = [...normalizedFound].some(f =>
      f.startsWith(normalizedExp) || normalizedExp.startsWith(f)
    );

    if (partialMatch) {
      matched.push(exp);
    } else {
      missing.push(exp);
    }
  }

  // Pass if at least half of expected references are found
  // (some queries have multiple expected refs, finding most is OK)
  const passThreshold = Math.ceil(expected.length / 2);
  return {
    passed: matched.length >= passThreshold,
    matched,
    missing,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== API Benchmark ===");
  console.log(`Target: ${BASE_URL}`);
  if (categoryArg) console.log(`Category filter: ${categoryArg}`);
  console.log("");

  // Step 1: Check if the server is reachable
  console.log("Checking if the server is running...");
  try {
    const healthCheck = await fetch(`${BASE_URL}/api/search?q=test&mode=references&stream=false`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!healthCheck.ok) {
      console.error(`ERROR: Server returned HTTP ${healthCheck.status}`);
      console.error("Make sure your dev server is running (npm run dev) or check the URL.");
      process.exit(1);
    }
    console.log("Server is running. Starting benchmark.\n");
  } catch (err: any) {
    console.error("ERROR: Cannot connect to " + BASE_URL);
    console.error("Did you run 'npm run dev' in another terminal window?");
    process.exit(1);
  }

  // Step 2: Load benchmark queries
  console.log("Loading benchmark queries from Supabase...");
  const queries = await fetchBenchmarkQueries();
  console.log(`Loaded ${queries.length} queries.\n`);

  // Step 3: Run each query
  const results: QueryResult[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (let i = 0; i < queries.length; i++) {
    const bq = queries[i];

    const apiResult = await callSearchAPI(bq.query);

    if (apiResult.error) {
      errors++;
      results.push({
        query: bq.query,
        category: bq.category,
        difficulty: bq.difficulty,
        passed: false,
        expected: bq.expected_references || [],
        found: [],
        matched: [],
        missing: bq.expected_references || [],
        totalResults: 0,
        durationMs: apiResult.durationMs,
        error: apiResult.error,
      });
    } else {
      const check = checkResult(
        bq.expected_references || [],
        apiResult.references,
        bq,
      );

      if (check.passed) passed++;
      else failed++;

      results.push({
        query: bq.query,
        category: bq.category,
        difficulty: bq.difficulty,
        passed: check.passed,
        expected: bq.expected_references || [],
        found: apiResult.references.slice(0, 20), // top 20 for readability
        matched: check.matched,
        missing: check.missing,
        totalResults: apiResult.totalResults,
        durationMs: apiResult.durationMs,
      });
    }

    // Progress update every 10 queries
    if ((i + 1) % 10 === 0 || i === queries.length - 1) {
      const total = i + 1;
      const pct = ((passed / total) * 100).toFixed(1);
      const avgMs = Math.round(results.reduce((s, r) => s + r.durationMs, 0) / total);
      console.log(
        `  ${total}/${queries.length} | ✓ ${passed} | ✗ ${failed} | errors ${errors} | pass rate ${pct}% | avg ${avgMs}ms | ${elapsed()}`
      );
    }

    // Don't hammer the server
    if (i < queries.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_QUERIES));
    }
  }

  // Step 4: Print score card
  console.log("\n");
  console.log("═".repeat(65));
  console.log("  BENCHMARK RESULTS");
  console.log("═".repeat(65));
  console.log("");

  // Group by category
  const categories = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    if (!categories.has(r.category)) {
      categories.set(r.category, { total: 0, passed: 0 });
    }
    const cat = categories.get(r.category)!;
    cat.total++;
    if (r.passed) cat.passed++;
  }

  // Print table
  console.log("  Category              | Total | Passed | Rate");
  console.log("  " + "─".repeat(55));

  const sortedCategories = [...categories.entries()].sort((a, b) => {
    const rateA = a[1].passed / a[1].total;
    const rateB = b[1].passed / b[1].total;
    return rateA - rateB; // worst first
  });

  for (const [cat, data] of sortedCategories) {
    const rate = ((data.passed / data.total) * 100).toFixed(1);
    const label = cat.padEnd(22);
    const total = String(data.total).padStart(5);
    const pass = String(data.passed).padStart(6);
    console.log(`  ${label} |${total} |${pass} | ${rate}%`);
  }

  console.log("  " + "─".repeat(55));
  const overallRate = ((passed / results.length) * 100).toFixed(1);
  console.log(`  ${"OVERALL".padEnd(22)} |${String(results.length).padStart(5)} |${String(passed).padStart(6)} | ${overallRate}%`);
  console.log("");

  // Group by difficulty
  console.log("  Difficulty | Total | Passed | Rate");
  console.log("  " + "─".repeat(42));
  const difficulties = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    if (!difficulties.has(r.difficulty)) {
      difficulties.set(r.difficulty, { total: 0, passed: 0 });
    }
    const diff = difficulties.get(r.difficulty)!;
    diff.total++;
    if (r.passed) diff.passed++;
  }
  for (const [diff, data] of [...difficulties.entries()].sort()) {
    const rate = ((data.passed / data.total) * 100).toFixed(1);
    console.log(`  ${diff.padEnd(11)} |${String(data.total).padStart(5)} |${String(data.passed).padStart(6)} | ${rate}%`);
  }
  console.log("");

  // Show failures
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log(`  ${failures.length} FAILURES:`);
    console.log("  " + "─".repeat(55));
    for (const f of failures.slice(0, 30)) {
      console.log(`  ✗ [${f.category}/${f.difficulty}] "${f.query}"`);
      if (f.error) {
        console.log(`    Error: ${f.error}`);
      } else {
        if (f.missing.length > 0) console.log(`    Missing: ${f.missing.join(", ")}`);
        console.log(`    Found ${f.totalResults} results total`);
      }
    }
    if (failures.length > 30) {
      console.log(`  ... and ${failures.length - 30} more (see benchmark-results.json)`);
    }
  }

  console.log("");
  console.log(`  Time: ${elapsed()}`);
  console.log("═".repeat(65));

  // Step 5: Save full report
  const report = {
    generated_at: new Date().toISOString(),
    target: BASE_URL,
    duration: elapsed(),
    summary: {
      total: results.length,
      passed,
      failed,
      errors,
      pass_rate: overallRate + "%",
      by_category: Object.fromEntries(
        sortedCategories.map(([cat, data]) => [
          cat,
          { total: data.total, passed: data.passed, rate: ((data.passed / data.total) * 100).toFixed(1) + "%" },
        ])
      ),
      by_difficulty: Object.fromEntries(
        [...difficulties.entries()].map(([diff, data]) => [
          diff,
          { total: data.total, passed: data.passed, rate: ((data.passed / data.total) * 100).toFixed(1) + "%" },
        ])
      ),
    },
    failures: failures.map(f => ({
      query: f.query,
      category: f.category,
      difficulty: f.difficulty,
      expected: f.expected,
      found_top10: f.found.slice(0, 10),
      matched: f.matched,
      missing: f.missing,
      totalResults: f.totalResults,
      error: f.error || null,
    })),
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nFull report saved to: benchmark-results.json`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
