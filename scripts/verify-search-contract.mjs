#!/usr/bin/env node
/**
 * verify-search-contract.mjs — Prove the database can actually serve a search.
 *
 * Run against a real database, after applying the restore migration:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/verify-search-contract.mjs
 *
 * This is deliberately NOT a vitest test. A test that skips itself when
 * credentials are absent reports green in CI while proving nothing, which is
 * the same class of false reassurance that let the outage run: a check that
 * cannot fail is not a check. Missing credentials are a hard failure here.
 *
 * Verifies, in order:
 *   1. every RPC the application calls exists with the exact expected signature
 *   2. no ambiguous overloads
 *   3. the search functions are SECURITY INVOKER with a pinned search_path
 *   4. each lane actually returns rows for a real query
 *   5. exact-reference lookup resolves BG 18.66
 *   6. a nonsense query returns a genuine empty result rather than an error
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error(
    "FAIL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.\n" +
      "This script verifies a live database contract and cannot be skipped.",
  );
  process.exit(1);
}

const db = createClient(url, key);
let failures = 0;
let checks = 0;

function report(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Any Postgres error is a failure; an empty array is not. */
async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.code || "?"} ${error.message || ""}`);
  return data ?? [];
}

console.log("\n1. RPC contract manifest (search_rpc_contract_v1)");
let contract;
try {
  contract = await rpc("search_rpc_contract_v1", {});
} catch (err) {
  console.error(`  FAIL  contract function unavailable — ${err.message}`);
  console.error("\nThe restore migration has probably not been applied yet.");
  process.exit(1);
}

const missing = contract.filter(r => !r.present);
report(missing.length === 0, `all ${contract.length} RPCs present`, missing.map(r => r.rpc_name).join(", "));

const ambiguous = contract.filter(r => r.overloads > 1);
report(ambiguous.length === 0, "no ambiguous overloads", ambiguous.map(r => r.rpc_name).join(", "));

const searchFns = contract.filter(r => r.rpc_name.startsWith("search_") || r.rpc_name === "direct_verse_lookup");
const definers = searchFns.filter(r => r.security_definer === true);
report(definers.length === 0, "search functions are SECURITY INVOKER", definers.map(r => r.rpc_name).join(", "));

const unpinned = searchFns.filter(r => !Array.isArray(r.proconfig) || !r.proconfig.some(c => c.startsWith("search_path=")));
report(unpinned.length === 0, "search functions pin search_path", unpinned.map(r => r.rpc_name).join(", "));

const logSearch = contract.find(r => r.rpc_name === "log_search");
report(logSearch?.security_definer === false, "log_search is no longer SECURITY DEFINER");

console.log("\n2. Retrieval lanes return real rows");
const QUERY = "chanting the holy name";
for (const [fn, args, label] of [
  ["search_verses_fulltext_v2", { search_query: QUERY, match_count: 10 }, "verses / full-text"],
  ["search_prose_fulltext_v2", { search_query: QUERY, match_count: 10 }, "prose / full-text"],
  ["search_transcript_paragraphs_fulltext", { search_query: QUERY, match_count: 10 }, "transcripts / full-text"],
  ["search_letter_paragraphs_fulltext", { search_query: QUERY, match_count: 8 }, "letters / full-text"],
  ["search_verse_chunks_fulltext", { search_query: QUERY, match_count: 10 }, "verse chunks / full-text"],
]) {
  try {
    const rows = await rpc(fn, args);
    report(rows.length > 0, `${label} (${rows.length} rows)`);
  } catch (err) {
    report(false, label, err.message);
  }
}

console.log("\n3. Exact-reference lookup");
try {
  const rows = await rpc("direct_verse_lookup", { ref_query: "BG 18.66" });
  const hit = rows[0];
  report(rows.length > 0, `BG 18.66 resolves (${rows.length} rows)`);
  if (hit) {
    report(hit.scripture === "BG", "scripture is BG", hit.scripture);
    report(Boolean(hit.translation), "translation present");
    report(Boolean(hit.vedabase_url), "citation URL present");
    report(Array.isArray(hit.tags), "tags array present (sourced from tags_core)");
  }
} catch (err) {
  report(false, "BG 18.66 lookup", err.message);
}

console.log("\n4. Canonical-slug tag lane (restored, disabled at the call site)");
try {
  const rows = await rpc("search_verses_by_tags", { search_terms: ["krsna"], match_count: 5 });
  report(rows.length > 0, `known slug returns rows (${rows.length})`);
  const none = await rpc("search_verses_by_tags", { search_terms: ["not-a-real-slug"], match_count: 5 });
  report(none.length === 0, "unknown slug returns a genuine empty result, not an error");
} catch (err) {
  report(false, "tag lane", err.message);
}

console.log("\n5. Genuine emptiness is distinguishable from failure");
try {
  const rows = await rpc("search_verses_fulltext_v2", {
    search_query: "zzzqqxx nonexistent gibberish token",
    match_count: 10,
  });
  report(rows.length === 0, "nonsense query returns [] without error");
} catch (err) {
  report(false, "nonsense query", err.message);
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILED.`);
  process.exit(1);
}
console.log("Search contract verified.\n");
