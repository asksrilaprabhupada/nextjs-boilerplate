/**
 * The qa_archive migration must describe exactly the private table Job 5 asked
 * for — and nothing wider.
 *
 * This table is the one place in the project that stores raw questions, so the
 * privacy properties are not style preferences: a stray policy, an anon grant,
 * or a missing RLS line would expose every devotee's question. They are
 * asserted here against the committed SQL so a later edit cannot loosen them
 * quietly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20260815120000_qa_archive.sql";
const ROLLBACK = "supabase/rollbacks/20260815120000_disable_qa_archive.sql";

/** The file minus its comment lines — only what would actually execute. */
function executable(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const migration = executable(MIGRATION);
const rollback = executable(ROLLBACK);

describe("qa_archive table shape", () => {
  it("creates the table with every column the archive needs", () => {
    expect(migration).toContain("CREATE TABLE public.qa_archive");
    for (const column of [
      "id uuid PRIMARY KEY",
      "search_log_id uuid",
      "request_id uuid NOT NULL UNIQUE",
      "question text NOT NULL",
      "response_json jsonb",
      "status text NOT NULL",
      "created_at timestamptz NOT NULL DEFAULT now()",
      "completed_at timestamptz",
      "drive_file_id text",
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("allows only the three statuses", () => {
    expect(migration).toContain("status IN ('running', 'success', 'failed')");
  });

  it("refuses to hold an invented answer", () => {
    // A failed row may never carry a response, and a success row must carry
    // one. The database, not just the writer, enforces this.
    expect(migration).toContain("qa_archive_status_shape");
    expect(migration).toContain(
      "(status = 'failed' AND response_json IS NULL AND completed_at IS NOT NULL)",
    );
    expect(migration).toContain(
      "(status = 'success' AND response_json IS NOT NULL AND completed_at IS NOT NULL)",
    );
  });

  it("keeps search_log_id nullable so fail-open telemetry cannot lose a question", () => {
    expect(migration).not.toMatch(/search_log_id uuid NOT NULL/);
    expect(migration).toContain("ON DELETE SET NULL");
  });

  it("reserves drive_file_id as a plain nullable column and builds no mirror", () => {
    // Job 5 reserves the column for a later Google Docs mirror and explicitly
    // does not build it now: no NOT NULL, no default, nothing to populate it.
    expect(migration).toMatch(/drive_file_id text,?\n/);
    expect(migration).not.toMatch(/drive_file_id text[^,\n]*(NOT NULL|DEFAULT)/);
  });
});

describe("the two-year retention the owner chose", () => {
  it("fixes the reduction point at two years, derived from created_at", () => {
    expect(migration).toContain("created_at <= now() - interval '2 years'");
    // Not a stored column: timestamptz + interval is STABLE, so a generated
    // column is rejected, and a defaulted one could be back-dated by a write.
    expect(migration).not.toContain("GENERATED ALWAYS AS");
  });

  it("reduces a row rather than deleting it", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.reduce_qa_archive");
    // Nothing in the retention path removes a row or a question.
    expect(migration).not.toContain("DELETE FROM public.qa_archive");
    expect(migration).not.toMatch(/UPDATE public\.qa_archive[\s\S]*?SET[\s\S]*?question\s*=/);
  });

  it("keeps the question, the main passages and their citations", () => {
    for (const kept of ["'query'", "'passages'", "'citations'"]) {
      expect(migration).toContain(kept);
    }
  });

  it("removes the Dig Deeper section and only it", () => {
    // The allowlist is the whole wire contract minus the three Dig Deeper keys.
    // Asserted against the live contract so a shape change is caught here.
    const contract = readFileSync("app/lib/types/01-search.ts", "utf8");
    const results = contract.slice(contract.indexOf("export interface SearchResults"));
    const body = results.slice(0, results.indexOf("\n}"));
    const contractKeys = [...body.matchAll(/^\s{2}(\w+)\??:/gmu)].map((m) => m[1]);
    const digDeeperOnly = ["additional", "additionalCount", "additionalTruncated"];

    const allowlist = migration.slice(migration.indexOf("kept_keys constant text[]"));
    const listed = [...allowlist.slice(0, allowlist.indexOf("];")).matchAll(/'(\w+)'/gu)]
      .map((m) => m[1]);

    expect(contractKeys.length).toBeGreaterThan(10);
    for (const key of contractKeys) {
      if (digDeeperOnly.includes(key)) expect(listed).not.toContain(key);
      else expect(listed).toContain(key);
    }
  });

  it("is not scheduled by the migration itself", () => {
    // Turning the job on is a separately approved cron.schedule call.
    expect(migration).not.toContain("cron.schedule");
  });

  it("reduces in lock-skipping batches so it cannot block a live search", () => {
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("LIMIT p_limit");
  });

  it("never lets a browser role run the reduction", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.reduce_qa_archive(integer) FROM anon, authenticated",
    );
  });
});

describe("qa_archive is private", () => {
  it("enables row level security", () => {
    expect(migration).toContain("ALTER TABLE public.qa_archive ENABLE ROW LEVEL SECURITY");
  });

  it("creates no policy for any browser role", () => {
    expect(migration).not.toContain("CREATE POLICY");
  });

  it("revokes everything from the public and browser roles", () => {
    expect(migration).toContain("REVOKE ALL ON TABLE public.qa_archive FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON TABLE public.qa_archive FROM anon, authenticated");
  });

  it("grants the service role read and write, but never delete or truncate", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE public.qa_archive TO service_role",
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*qa_archive/);
    expect(migration).not.toMatch(/GRANT[^;]*TRUNCATE[^;]*qa_archive/);
    expect(migration).not.toMatch(/GRANT[^;]*ALL[^;]*qa_archive/);
  });

  it("verifies its own privacy at apply time", () => {
    expect(migration).toContain("RAISE EXCEPTION 'qa_archive RLS is not enabled'");
    expect(migration).toContain("RAISE EXCEPTION 'qa_archive must have no browser policies'");
    expect(migration).toContain("has_table_privilege('anon'");
    expect(migration).toContain("has_table_privilege('authenticated'");
  });

  it("reloads the PostgREST schema cache", () => {
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe("the rollback is non-destructive", () => {
  it("makes the table inert without dropping or deleting anything", () => {
    expect(rollback).toContain("REVOKE SELECT, INSERT, UPDATE ON TABLE public.qa_archive");
    expect(rollback).not.toContain("DROP TABLE");
    expect(rollback).not.toContain("DELETE FROM");
    expect(rollback).not.toContain("TRUNCATE");
  });

  it("keeps the destructive DROP commented out and unreachable", () => {
    const raw = readFileSync(ROLLBACK, "utf8");
    expect(raw).toContain("-- DROP TABLE public.qa_archive;");
  });
});
