/**
 * semantic-limit-migration.test.ts — the guard on the guard.
 *
 * This migration moves two numbers from 200 to 100 while a THIRD number that
 * happens to also be 200 — ef_search — must not move. That collision is the
 * whole hazard: `200` appears six times in each function body (seven in
 * transcripts), and a careless anchor would take ef_search down with the
 * semantic budgets, silently halving what the HNSW graph is willing to
 * consider at the same time as halving what it is asked to return.
 *
 * The previous rewrite of these functions had it easier — ef_search was moving
 * from 400, so nothing could confuse the two values. It still needed the
 * byte-for-byte reversal check, and it still found something: the transcripts
 * function's Unicode literal U&'[\0300-\036f]', the combining-diacritics range,
 * which a blind numeric replace would have corrupted into nonsense that still
 * parsed.
 *
 * These tests read the SQL as text, before any database is touched.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEARCH_V2_CONFIG } from "@/app/lib/search-v2/config";

const migration = readFileSync(
  "supabase/migrations/20260817193000_semantic_limit_100.sql", "utf8",
);
const rollback = readFileSync(
  "supabase/rollbacks/20260817193000_semantic_limit_100_rollback.sql", "utf8",
);

/** Every `replace(` argument pair in a script, in order. */
function replacements(sql: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /replace\((?:old_def|new_def|restored),\s*\n?\s*([\s\S]*?),\n\s*([\s\S]*?)\);/g;
  for (const m of sql.matchAll(re)) out.push([m[1].trim(), m[2].trim()]);
  return out;
}

describe("every anchor is safe against the ef_search collision", () => {
  it("names p_semantic_limit in every substitution that mentions a budget", () => {
    // ef_search's clause is `SET "hnsw.ef_search" TO '200'`. It contains no
    // `p_semantic_limit`, so an anchor that does cannot match it. This is the
    // structural reason the rewrite is safe, asserted rather than assumed.
    for (const [from, to] of replacements(migration)) {
      if (!/\b200\b|\b100\b/.test(from)) continue;
      const isCommentRewrite = from.includes("-- The clamp");
      if (isCommentRewrite) continue;
      expect(from).toContain("p_semantic_limit");
      expect(to).toContain("p_semantic_limit");
    }
  });

  it("never writes an ef_search substitution at all", () => {
    for (const [from, to] of replacements(migration)) {
      expect(from).not.toContain("hnsw.ef_search");
      expect(to).not.toContain("hnsw.ef_search");
    }
  });

  it("asserts ef_search 200 survived, per function, before writing it", () => {
    expect(migration).toContain(
      `IF position('SET "hnsw.ef_search" TO ''200''' in new_def) = 0 THEN`,
    );
    expect(migration).toContain("ef_search 200 was lost by the rewrite");
    // And again afterwards, read back off proconfig rather than off the text.
    expect(migration).toContain("WHERE c = 'hnsw.ef_search=200'");
  });
});

describe("the byte-for-byte reversal guard is intact", () => {
  it("reverses every forward substitution and compares against the original", () => {
    const forward = replacements(migration).filter(([, to]) => to.includes("100")
      || to.includes("deliberately BELOW"));
    const reverse = replacements(migration).filter(([from]) => from.includes("100")
      || from.includes("deliberately BELOW"));
    expect(forward.length).toBeGreaterThan(0);
    // Each forward pair has a mirror image in the reversal block.
    for (const [from, to] of forward) {
      expect(reverse.some(([rFrom, rTo]) => rFrom === to && rTo === from)).toBe(true);
    }
  });

  it("aborts having replaced nothing when the reversal does not match", () => {
    expect(migration).toContain("IF restored IS DISTINCT FROM old_def THEN");
    expect(migration).toContain("refusing to replace %");
    // The EXECUTE must come after the check, never before it.
    expect(migration.indexOf("IF restored IS DISTINCT FROM old_def"))
      .toBeLessThan(migration.indexOf("EXECUTE new_def"));
  });

  it("refuses a no-op rewrite rather than reporting success", () => {
    expect(migration).toContain("neither semantic budget was found");
    expect(migration).toContain("expected exactly five batch retrieval functions");
  });

  it("re-checks the diacritic range as SOURCE TEXT, not as codepoints", () => {
    // pg_get_functiondef returns the escaped source. Searching for the decoded
    // form finds nothing and fails a migration that is perfectly correct.
    expect(migration).toContain(`position('U&''[\\0300-\\036f]''' in transcripts_def)`);
  });
});

describe("it is forward-only and touches nothing else", () => {
  it("edits no applied migration and drops nothing", () => {
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|REINDEX|ALTER\s+TABLE)\b/i);
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|CREATE\s+POLICY)\b/i);
  });

  it("reloads the PostgREST schema cache so the new signature is visible", () => {
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
    expect(rollback).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it("loads the vector library first, or CREATE OR REPLACE would be refused", () => {
    // hnsw.ef_search is an undefined placeholder GUC until a vector operation
    // loads the library, and a non-superuser cannot put a placeholder in a
    // function's SET clause — even one the function already carries.
    for (const sql of [migration, rollback]) {
      expect(sql).toContain("OPERATOR(extensions.<#>)");
      expect(sql).toContain("hnsw.ef_search is still undefined");
      expect(sql.indexOf("hnsw.ef_search is still undefined"))
        .toBeLessThan(sql.indexOf("EXECUTE new_def"));
    }
  });
});

describe("the rollback is the mirror, with the same guard", () => {
  it("puts both budgets back to 200 and keeps ef_search at 200", () => {
    expect(rollback).toContain("'p_semantic_limit integer DEFAULT 200)'");
    expect(rollback).toContain("'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)'");
    expect(rollback).toContain(
      `IF position('SET "hnsw.ef_search" TO ''200''' in new_def) = 0 THEN`,
    );
  });

  it("carries the same byte-for-byte check, so it cannot revert later work", () => {
    expect(rollback).toContain("IF restored IS DISTINCT FROM old_def THEN");
    expect(rollback).toContain("something other than the semantic budgets differs");
  });

  it("refuses to run when the 100 budgets are not there to roll back", () => {
    expect(rollback).toContain("the 100 budgets are not present");
  });
});

describe("the application agrees with the SQL", () => {
  it("sends the same semantic limit the RPC clamps to", () => {
    // The RPC is the authority — it clamps whatever is sent. Sending a larger
    // number still works, but it makes the config a description of something
    // that is not happening, which is how it came to say 300 while SQL said 200.
    expect(SEARCH_V2_CONFIG.perSourceSemanticLimit).toBe(100);
  });
});
