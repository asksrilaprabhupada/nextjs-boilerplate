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
 * It EXECUTES every restored function rather than merely checking that it
 * exists. That distinction matters: the first version of the migration declared
 * the five semantic functions STABLE with a body-level `SET LOCAL`, which
 * creates cleanly and then fails on first call. Presence checking passes;
 * execution does not.
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
  if (error) throw new Error(`${error.code || "?"} ${error.message || ""}`.trim());
  return data ?? [];
}

/** Execute an RPC and report pass/fail, returning the rows (or null on error). */
async function exercise(label, name, args, { expectRows = true } = {}) {
  try {
    const rows = await rpc(name, args);
    const ok = expectRows ? rows.length > 0 : Array.isArray(rows);
    report(ok, `${label} (${rows.length} rows)`, ok ? "" : "returned no rows");
    return rows;
  } catch (err) {
    report(false, label, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
console.log("\n1. Contract manifest — every RPC compatible");
let contract;
try {
  contract = await rpc("search_rpc_contract_v1", {});
} catch (err) {
  console.error(`  FAIL  contract function unavailable — ${err.message}`);
  console.error("\nThe restore migration has probably not been applied yet.");
  process.exit(1);
}

const incompatible = contract.filter(r => !r.compatible);
report(incompatible.length === 0, `all ${contract.length} RPCs compatible`);
for (const r of incompatible) {
  const why = [
    !r.present && "absent",
    r.overloads > 1 && `${r.overloads} overloads`,
    !r.result_matches && "return type drift",
    !r.security_invoker && "SECURITY DEFINER",
    !r.search_path_pinned && "search_path not pinned",
    !r.ef_search_pinned && "ef_search not pinned",
    !r.service_role_executable && "service_role cannot execute",
    r.publicly_executable && "publicly executable",
  ].filter(Boolean).join(", ");
  console.error(`        ${r.rpc_name}: ${why}`);
}

// ---------------------------------------------------------------------------
console.log("\n2. Full-text lanes execute");
const QUERY = "chanting the holy name";
await exercise("verses / full-text v2", "search_verses_fulltext_v2", { search_query: QUERY, match_count: 10 });
await exercise("prose / full-text v2", "search_prose_fulltext_v2", { search_query: QUERY, match_count: 10 });
await exercise("transcripts / full-text", "search_transcript_paragraphs_fulltext", { search_query: QUERY, match_count: 10 });
await exercise("letters / full-text", "search_letter_paragraphs_fulltext", { search_query: QUERY, match_count: 8 });
await exercise("verse chunks / full-text", "search_verse_chunks_fulltext", { search_query: QUERY, match_count: 10 });
// Legacy v1 contracts — reachable from the fallback path, so they must work too.
await exercise("verses / full-text v1 (legacy)", "search_verses_fulltext", { search_query: QUERY, match_count: 10 });
await exercise("prose / full-text v1 (legacy)", "search_prose_fulltext", { search_query: QUERY, match_count: 10 });

// ---------------------------------------------------------------------------
console.log("\n3. Semantic lanes execute with a real 1024-dim vector");
// This section is the reason the script exists in this form. A STABLE function
// with a body-level SET is created without complaint and fails only when called.
let probeVector = null;
try {
  const { data, error } = await db
    .from("verses")
    .select("embedding_context4")
    .not("embedding_context4", "is", null)
    .limit(1);
  if (error) throw new Error(`${error.code || "?"} ${error.message || ""}`);
  probeVector = data?.[0]?.embedding_context4 ?? null;
  const dims = typeof probeVector === "string"
    ? probeVector.split(",").length
    : Array.isArray(probeVector) ? probeVector.length : 0;
  report(dims === 1024, `fetched a stored probe vector (${dims} dims)`);
} catch (err) {
  report(false, "fetch probe vector", err.message);
}

if (probeVector) {
  const v = typeof probeVector === "string" ? probeVector : `[${probeVector.join(",")}]`;
  await exercise("verses / semantic", "search_verses_semantic_v2", { query_embedding: v, match_count: 5 });
  await exercise("prose / semantic", "search_prose_semantic_v2", { query_embedding: v, match_count: 5 });
  await exercise("verse chunks / semantic", "search_verse_chunks_semantic", { query_embedding: v, match_count: 5 });
  await exercise("transcripts / semantic", "search_transcript_paragraphs_semantic", { query_embedding: v, match_count: 5 });
  await exercise("letters / semantic", "search_letter_paragraphs_semantic", { query_embedding: v, match_count: 5 });
} else {
  report(false, "semantic lanes", "no probe vector available");
}

// ---------------------------------------------------------------------------
console.log("\n4. Tag lanes execute (restored; disabled at the call site)");
await exercise("verses / by tags", "search_verses_by_tags", { search_terms: ["krsna"], match_count: 5 });
await exercise("prose / by tags", "search_prose_by_tags", { search_terms: ["krsna"], match_count: 5 });
await exercise("verse chunks / by tags", "search_verse_chunks_by_tags", { search_terms: ["krsna"], match_count: 5 });
await exercise("transcripts / by tags", "search_transcript_paragraphs_by_tags", { search_terms: ["krsna"], match_count: 5 });
await exercise("letters / by tags", "search_letter_paragraphs_by_tags", { search_terms: ["krsna"], match_count: 5 });
try {
  const none = await rpc("search_verses_by_tags", { search_terms: ["not-a-real-slug"], match_count: 5 });
  report(none.length === 0, "unknown slug returns a genuine empty result, not an error");
} catch (err) {
  report(false, "unknown slug handling", err.message);
}

// ---------------------------------------------------------------------------
console.log("\n5. Exact-reference lookup and enrichment");
const bg = await exercise("BG 18.66 resolves", "direct_verse_lookup", { ref_query: "BG 18.66" });
if (bg && bg.length > 0) {
  const hit = bg[0];
  report(hit.scripture === "BG", "scripture is BG", hit.scripture);
  report(Boolean(hit.translation), "translation present");
  report(Boolean(hit.vedabase_url), "citation URL present");
  report(Array.isArray(hit.tags), "tags array present (sourced from tags_core)");
  await exercise("chapter context", "get_verse_context", { p_verse_id: hit.id, p_radius: 1 });
}
// suggest_spelling was raising 42883 before this migration; a clean call is the
// proof it is repaired. It legitimately returns zero rows when nothing is
// misspelled, so only the absence of an error is asserted.
await exercise("spelling suggestions", "suggest_spelling", { raw_query: "krsna conciousness" }, { expectRows: false });

// ---------------------------------------------------------------------------
console.log("\n6. Genuine emptiness is distinguishable from failure");
try {
  const rows = await rpc("search_verses_fulltext_v2", {
    search_query: "zzzqqxx nonexistent gibberish token",
    match_count: 10,
  });
  report(rows.length === 0, "nonsense query returns [] without error");
} catch (err) {
  report(false, "nonsense query", err.message);
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILED.`);
  process.exit(1);
}
console.log("Search contract verified.\n");
