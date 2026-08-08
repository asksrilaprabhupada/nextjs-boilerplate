/**
 * tags-fts-migration-record.test.ts — the committed file must describe the
 * database that exists, not the one that was planned.
 *
 * This migration had no ledger row, and comparing it against the live database
 * (part A3) showed it declared more than was ever run: three columns, a table,
 * six indexes, and two trigger lines that were never applied. Recording it as
 * "applied" while it still said that would have written the discrepancy into
 * the ledger rather than resolving it.
 *
 * The executable statements are asserted here against what was verified live on
 * 2026-08-08. These are not style checks — a re-added `questions_fts` line in
 * the trigger, with no such column on the table, would make every insert and
 * update on all five content tables fail.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "supabase/migrations/20260708120000_tags_fts_rebuild_columns_and_fts_core.sql";
const migration = readFileSync(PATH, "utf8");

/** The file minus its comment lines — only what would actually execute. */
const executable = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("tags/FTS migration matches the live database", () => {
  it("declares the four columns that exist", () => {
    for (const column of ["tags_core", "fts_core", "fts_expansion", "fts_expansion_src"]) {
      expect(executable).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(executable.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(4);
  });

  it("declares NONE of the three columns that do not exist", () => {
    // Absent from all five content tables, and read by nothing: not one of the
    // 30 live search/trigger functions, not the application source.
    for (const column of ["tags_ai", "questions_fts", "questions text"]) {
      expect(executable).not.toContain(column);
    }
  });

  it("does not create the tag_batch_jobs table, which was never created", () => {
    expect(executable).not.toContain("tag_batch_jobs");
  });

  it("does not create the partial tags_core indexes, which were never created", () => {
    expect(executable).not.toContain("null_tags_core");
  });

  it("keeps the trigger bodies to the two vectors the live triggers actually set", () => {
    // The live bodies set fts_core and fts_expansion and stop. A NEW.questions_fts
    // assignment here, against a column that does not exist, would break every
    // write to verses, verse_chunks, prose, transcripts and letters.
    expect(executable).not.toContain("NEW.questions_fts");
    expect(executable.match(/NEW\.fts_core :=/g)).toHaveLength(2);
    expect(executable.match(/NEW\.fts_expansion :=/g)).toHaveLength(2);
  });

  it("still creates what IS live — vocab_terms and the five triggers", () => {
    expect(executable).toContain("CREATE TABLE IF NOT EXISTS public.vocab_terms");
    for (const trigger of [
      "trg_verses_search_vectors",
      "trg_vchunks_search_vectors",
      "trg_prose_search_vectors",
      "trg_transcript_search_vectors",
      "trg_letter_search_vectors",
    ]) {
      expect(executable).toContain(trigger);
    }
  });

  it("records why the file was corrected, so the next reader is not puzzled", () => {
    expect(migration).toContain("CORRECTED 2026-08-08 TO MATCH WHAT WAS ACTUALLY APPLIED");
  });

  it("touches no content rows and drops nothing but its own triggers", () => {
    // Matched as statements, not as words: "BEFORE INSERT OR UPDATE" is a
    // trigger event, not a write.
    expect(executable).not.toMatch(/\bUPDATE\s+(?:public\.|only\s)/i);
    expect(executable).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
    // The only DROPs are the idempotent `DROP TRIGGER IF EXISTS` pairs.
    const drops = executable.match(/DROP\s+\w+/gi) ?? [];
    expect(drops.every((d) => /DROP\s+TRIGGER/i.test(d))).toBe(true);
  });
});
