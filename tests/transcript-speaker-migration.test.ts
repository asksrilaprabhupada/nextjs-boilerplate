import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrations = join(process.cwd(), "supabase", "migrations");
const corrected = join(
  migrations,
  "20260802223000_transcripts_v3_segment_presence_filter.sql",
);
const rollback = join(
  process.cwd(),
  "supabase",
  "rollbacks",
  "20260802223000_restore_transcripts_v3_pre_segment_filter.sql",
);

describe("segment-presence transcript migration proposal", () => {
  const sql = readFileSync(corrected, "utf8");

  it("removes the conflicting row-level speaker/backfill proposals", () => {
    expect(existsSync(join(migrations, "20260801120000_add_transcript_speaker.sql"))).toBe(false);
    expect(existsSync(join(migrations, "20260801121000_transcripts_v3_speaker_and_filter.sql"))).toBe(false);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+public\.transcript_paragraphs/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.transcript_paragraphs/i);
    expect(sql).not.toContain("t.speaker =");
  });

  it("preserves the function contract and hardening", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.@FN@(");
    expect(sql).toContain("RETURNS TABLE(");
    expect(sql).toContain("'NULL::text'");
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain("SET hnsw.ef_search = '400'");
    expect(sql).toContain("pg_catalog.normalize(");
    expect(sql).toContain("speaker_line.line_text ~ E'^[^:：]*[:：]'");
    expect(sql).toContain("pg_catalog.regexp_replace(speaker_line.line_text, E'[:：].*$', '')");
    expect(sql).toContain("U&'[\\0300-\\036f]'");
    expect(sql).toContain("'[^a-z ]'");
    expect(sql).toContain("IN ('prabhupada', 'srila prabhupada')");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION");
    expect(sql).toContain("TO service_role");
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it("keeps speaker filtering out of every retrieval lane", () => {
    const lanes = sql.slice(sql.indexOf("sem AS ("), sql.indexOf("sat AS ("));
    expect(lanes).not.toContain("speaker_only");

    const finalJoin = sql.indexOf("FROM agg a");
    const finalRegex = sql.indexOf("regexp_split_to_table", finalJoin);
    const finalLimit = sql.indexOf("LIMIT p_limit;", finalJoin);
    expect(finalJoin).toBeGreaterThan(0);
    expect(finalRegex).toBeGreaterThan(finalJoin);
    expect(finalLimit).toBeGreaterThan(finalRegex);
  });

  it("documents a forward rollback with no table or index reversal", () => {
    expect(sql).toContain("ROLLBACK: apply a new forward migration");
    expect(sql).toContain("function definition AND COMMENT from 20260727120000");
    expect(sql).toContain("No table/data/index rollback is needed");
  });

  it("ships the exact captured predecessor as an inert rollback artifact", () => {
    const rollbackSql = readFileSync(rollback, "utf8");
    expect(rollbackSql).toContain("OWNER APPROVAL REQUIRED. DO NOT APPLY AUTOMATICALLY");
    expect(rollbackSql).toContain("f279df34ed55e0493e0c4f2f94cc0660");
    expect(rollbackSql).toContain("2dff515d4009d751888697e61410ef2a");
    expect(rollbackSql).toContain("CREATE OR REPLACE FUNCTION public.search_transcripts_hybrid_batch_v3");
    expect(rollbackSql).toContain("REVOKE ALL ON FUNCTION");
    expect(rollbackSql).toContain("TO service_role");
    expect(rollbackSql).toContain("NOTIFY pgrst, 'reload schema'");
    expect(rollbackSql).not.toMatch(/ALTER\s+TABLE|UPDATE\s+public\.transcript_paragraphs|CREATE\s+INDEX/i);
  });
});
