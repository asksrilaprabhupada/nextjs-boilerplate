import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260809121226_add_transcript_speaker_names.sql",
  ),
  "utf8",
);

const rollback = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "rollbacks",
    "20260809121226_leave_transcript_speaker_names_inert.sql",
  ),
  "utf8",
);

const ftsCoreBackfill = readFileSync(
  join(process.cwd(), "scripts", "tags-rebuild", "backfill_fts_core.py"),
  "utf8",
);

const executableMigration = migration.replace(/--.*$/gm, "");
const executableRollback = rollback.replace(/--.*$/gm, "").trim();

// Read-only production catalog audit on 2026-08-09. This is deliberately the
// exact raw pg_proc.prosrc hash, not a whitespace/case-normalized source hash.
const bodyVectorFingerprint = "2b79af99b4080b9c2c0b80ef8a642074";

describe("transcript speaker schema and backfill boundary", () => {
  it("adds exactly one nullable text-array column with no default or index", () => {
    expect(migration).toContain("OWNER APPROVAL REQUIRED. DO NOT APPLY AUTOMATICALLY");
    expect(executableMigration).toMatch(
      /ALTER\s+TABLE\s+public\.transcript_paragraphs\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+speaker_names\s+text\[\]\s*;/i,
    );
    expect(executableMigration.match(/\bADD\s+COLUMN\b/gi)).toHaveLength(1);
    expect(executableMigration).not.toMatch(
      /speaker_names\s+text\[\][^;]*(?:NOT\s+NULL|DEFAULT)/i,
    );
    expect(executableMigration).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
    expect(migration).toContain("NULL means not processed");
    expect(migration).toContain("an empty array means processed but no speaker was proved");
    expect(migration).toContain("Speaker not identified");
  });

  it("has bounded execution and preflight/postflight shape and RLS checks", () => {
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration).toContain("SET LOCAL lock_timeout = '3s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'");
    expect(migration).toContain("DO $preflight$");
    expect(migration).toContain("DO $verify$");
    expect(migration.match(/relrowsecurity/g)).toHaveLength(2);
    expect(migration.match(/'text\[\]'::pg_catalog\.regtype/g)).toHaveLength(2);
    expect(migration.match(/attnotnull/g)).toHaveLength(2);
    expect(migration.match(/pg_catalog\.pg_get_expr/g)).toHaveLength(2);
    expect(migration).toContain("speaker_names must not be indexed");
  });

  it("does not backfill or otherwise mutate transcript rows", () => {
    expect(executableMigration).not.toMatch(
      /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?)\b/i,
    );
    expect(executableMigration).not.toMatch(
      /\bUPDATE\s+(?:ONLY\s+)?(?:[a-z_][\w$]*\.)?[a-z_][\w$]*\s+SET\b/i,
    );
  });

  it("prevents speaker-only writes from recalculating search vectors", () => {
    expect(executableMigration).toMatch(
      /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_transcript_search_vectors\s+ON\s+public\.transcript_paragraphs\s*;/i,
    );
    expect(executableMigration).toMatch(
      /CREATE\s+TRIGGER\s+trg_transcript_search_vectors\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+body_text\s*,\s*fts_expansion_src\s*,\s*fts_core\s+ON\s+public\.transcript_paragraphs\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\.body_search_vectors_trigger\(\)\s*;/i,
    );
    expect(executableMigration).not.toMatch(
      /trg_transcript_search_vectors\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON/i,
    );
    expect(ftsCoreBackfill).toMatch(/SET\s+fts_core\s*=\s*fts_core/i);
    expect(executableMigration).toMatch(
      /UPDATE\s+OF\s+body_text\s*,\s*fts_expansion_src\s*,\s*fts_core/i,
    );
  });

  it("refuses an unexpected live trigger or vector-function body", () => {
    expect(migration).toContain(
      `v_expected_function_fingerprint constant text := '${bodyVectorFingerprint}'`,
    );
    expect(migration).toContain("p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype");
    expect(migration).toContain("p.provolatile = 'v'");
    expect(migration).toContain("AND NOT p.prosecdef");
    expect(migration).toContain(
      "v_expected_function_config constant text[] := ARRAY['search_path=public, pg_temp']",
    );
    expect(migration).toContain("pg_catalog.md5(p.prosrc), p.proconfig");
    expect(migration).toContain("v_trigger_type <> 23");
    expect(migration).toContain("v_trigger_enabled <> 'O'");
    expect(migration).toContain("v_trigger_function <> v_vector_function");
    expect(migration).toContain("v_trigger_has_condition");
    expect(migration).toContain("v_trigger_argument_count <> 0");
    expect(migration).toContain(
      "v_trigger_columns NOT IN ('', v_expected_trigger_columns)",
    );
  });

  it("reloads PostgREST only after verification", () => {
    const verifyAt = migration.indexOf("DO $verify$");
    const notifyAt = migration.indexOf("NOTIFY pgrst, 'reload schema'");

    expect(verifyAt).toBeGreaterThan(0);
    expect(notifyAt).toBeGreaterThan(verifyAt);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';\s*\n\s*COMMIT;/);
  });

  it("ships an inert, separately approved non-destructive rollback", () => {
    expect(rollback).toContain("OWNER APPROVAL REQUIRED. DO NOT APPLY AUTOMATICALLY");
    expect(rollback).toContain("previous application version");
    expect(rollback).toContain("nullable additive column");
    expect(rollback).toContain("explicit owner approval");
    expect(executableRollback).toBe("");
    expect(rollback).not.toMatch(/^\s*(?:DROP|UPDATE)\b/gim);
  });
});
