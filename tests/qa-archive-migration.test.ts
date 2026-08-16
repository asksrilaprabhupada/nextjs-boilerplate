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

const MIGRATION = "supabase/migrations/20260816135330_qa_archive.sql";
const ROLLBACK = "supabase/rollbacks/20260816135330_disable_qa_archive.sql";

/** The file minus its comment lines — only what would actually execute. */
function executable(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const migration = executable(MIGRATION);
const rollback = executable(ROLLBACK);

/** The reduction's allowlist, read out of the SQL and sorted for comparison. */
function keptKeys(): string[] {
  const from = migration.slice(migration.indexOf("kept_keys constant text[]"));
  const array = from.slice(0, from.indexOf("];"));
  return [...array.matchAll(/'(\w+)'/gu)].map((m) => m[1]).sort();
}

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

  it("allows only the four statuses", () => {
    expect(migration).toContain("status IN ('running', 'success', 'failed', 'abandoned')");
  });

  it("refuses to hold an invented answer", () => {
    // A failed or abandoned row may never carry a response, and a success row
    // must carry one. The database, not just the writer, enforces this.
    expect(migration).toContain("qa_archive_status_shape");
    expect(migration).toContain(
      "(status = 'failed' AND response_json IS NULL AND completed_at IS NOT NULL)",
    );
    expect(migration).toContain(
      "(status = 'abandoned' AND response_json IS NULL AND completed_at IS NOT NULL)",
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
    // Nothing in the RETENTION path removes a row or a question. Scoped to the
    // reduce function's own body: administrator erasure is a separate,
    // deliberate path and does contain a DELETE.
    const reduce = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.reduce_qa_archive"),
    );
    const body = reduce.slice(0, reduce.indexOf("$fn$;"));
    expect(body).not.toContain("DELETE");
    expect(body).not.toMatch(/SET[\s\S]*?question\s*=/);
  });

  it("keeps exactly the permitted keys, and no others", () => {
    // The owner's rule is literal: the raw question, the main passages, their
    // citations and source URLs, and genuinely non-content technical metadata.
    //
    // Twelve keys were approved. `rankingUnavailable` is the thirteenth, added
    // with the honest-rerank-failure work: a boolean saying whether the
    // relevance ranking completed. It carries no words, so it is metadata by
    // the same rule that admits `degraded` and `retrievalStatus`.
    expect(keptKeys()).toEqual([
      "citations",
      "degraded",
      "degradedSources",
      "disabledLanes",
      "droppedBlocks",
      "passages",
      "query",
      "rankingUnavailable",
      "requestId",
      "retrievalStatus",
      "searchLogId",
      "totalResults",
      "validated",
    ]);
  });

  it("permanently keeps no generated answer or framing content", () => {
    // These carry words that are not part of the main passages, so they do not
    // survive the two-year reduction.
    for (const generated of [
      "intro", "suggestion", "suggestionDisplay", "queryTerms", "queryVariants",
    ]) {
      expect(keptKeys()).not.toContain(generated);
    }
  });

  it("removes the whole Dig Deeper section", () => {
    for (const digDeeper of ["additional", "additionalCount", "additionalTruncated"]) {
      expect(keptKeys()).not.toContain(digDeeper);
    }
  });

  it("forces every wire-contract key to be deliberately classified", () => {
    // Read against the live contract: a key added to SearchResults later must
    // be consciously placed in one bucket or the other. Without this, a new
    // field would silently default to being dropped — or, if the allowlist were
    // ever rewritten as a blocklist, silently kept forever.
    const contract = readFileSync("app/lib/types/01-search.ts", "utf8");
    const results = contract.slice(contract.indexOf("export interface SearchResults"));
    const body = results.slice(0, results.indexOf("\n}"));
    const contractKeys = [...body.matchAll(/^\s{2}(\w+)\??:/gmu)].map((m) => m[1]);
    const dropped = [
      "additional", "additionalCount", "additionalTruncated",
      "intro", "suggestion", "suggestionDisplay", "queryTerms", "queryVariants",
    ];

    expect(contractKeys.length).toBeGreaterThan(10);
    const classified = new Set([...keptKeys(), ...dropped]);
    const unclassified = contractKeys.filter((key) => !classified.has(key));
    expect(unclassified).toEqual([]);
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

describe("safeguard: one record can be erased, by an administrator only", () => {
  it("erases exactly one record, by primary key", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.erase_qa_archive_record(p_id uuid, p_reason text)",
    );
    expect(migration).toContain("DELETE FROM public.qa_archive\n  WHERE id = p_id");
  });

  it("refuses to run without an id and a written reason", () => {
    expect(migration).toContain("requires the id of one record");
    expect(migration).toContain("requires a written reason");
    expect(migration).toContain("btrim(p_reason) = ''");
  });

  it("fails loudly when the id matches nothing", () => {
    // A mistyped id must not look like a successful erasure.
    expect(migration).toContain("does not exist; nothing was erased");
  });

  it("is callable by no role at all — not even the application", () => {
    for (const role of ["PUBLIC", "anon, authenticated", "service_role"]) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.erase_qa_archive_record(uuid, text) FROM ${role}`,
      );
    }
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.erase_qa_archive_record/);
  });

  it("still grants the application no DELETE on the table itself", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE public.qa_archive TO service_role",
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*ON TABLE public\.qa_archive/);
  });

  it("leaves a contentless audit row behind", () => {
    expect(migration).toContain("CREATE TABLE public.qa_archive_erasures");
    expect(migration).toContain("INSERT INTO public.qa_archive_erasures");
    // The audit must never carry what was erased, or the erasure is undone.
    const audit = migration.slice(
      migration.indexOf("CREATE TABLE public.qa_archive_erasures"),
    );
    const columns = audit.slice(0, audit.indexOf(");"));
    expect(columns).not.toContain("question");
    expect(columns).not.toContain("response_json");
  });

  it("keeps the audit read-only to the application", () => {
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.qa_archive_erasures TO service_role",
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'qa_archive_erasures must be read-only to the application'",
    );
  });
});

describe("safeguard: no row stays outside retention forever", () => {
  it("sweeps stale running rows to abandoned", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.settle_stale_qa_archive_rows",
    );
    expect(migration).toContain("SET status = 'abandoned'");
    expect(migration).toContain("WHERE status = 'running'");
  });

  it("keeps the question and invents no answer when settling", () => {
    const settle = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.settle_stale_qa_archive_rows"),
    );
    const body = settle.slice(0, settle.indexOf("$fn$;"));
    expect(body).not.toMatch(/SET[\s\S]*question\s*=/);
    expect(body).not.toMatch(/response_json\s*=/);
    expect(body).not.toContain("DELETE");
  });

  it("refuses a threshold short enough to race a running search", () => {
    // route.ts allows a search up to 300 seconds.
    expect(migration).toContain("p_older_than < interval '10 minutes'");
    expect(migration).toContain("a search may still be running");
  });

  it("brings abandoned rows into the two-year reduction", () => {
    expect(migration).toContain("status IN ('success', 'failed', 'abandoned')");
  });

  it("sweeps in lock-skipping batches", () => {
    const settle = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.settle_stale_qa_archive_rows"),
    );
    expect(settle.slice(0, settle.indexOf("$fn$;"))).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("is not callable from a browser role", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.settle_stale_qa_archive_rows(interval, integer)\n  FROM anon, authenticated",
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
    expect(migration).toContain("RAISE EXCEPTION 'qa_archive RLS is not enabled on both tables'");
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
