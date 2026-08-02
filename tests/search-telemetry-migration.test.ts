import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260802133000_authoritative_search_telemetry.sql",
  ),
  "utf8",
);

describe("authoritative search telemetry migration contract", () => {
  it("is additive and bounded by short lock and statement deadlines", () => {
    const executableSql = sql.replace(/--.*$/gm, "");

    expect(sql).toContain("SET LOCAL lock_timeout = '3s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(executableSql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/i);
    expect(sql).not.toContain("last_heartbeat_at");
  });

  it("adds every lifecycle field and both required indexes", () => {
    for (const field of [
      "request_id text",
      "environment text",
      "deployment_sha text",
      "status text",
      "failed_stage text",
      "error_code text",
      "stage_durations_ms jsonb",
      "source_durations_ms jsonb",
      "telemetry jsonb",
      "started_at timestamptz",
      "completed_at timestamptz",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${field}`);
    }

    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS search_logs_request_id_unique");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS search_logs_status_started_at_idx");
  });

  it("enforces full hashes, known states, and hash-only failed rows in SQL", () => {
    expect(sql).toContain("p_environment IS NULL OR p_environment NOT IN ('preview', 'production')");
    expect(sql).toContain("v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("p_status IS NULL OR p_status NOT IN");
    expect(sql).toContain("p_status IN ('failed', 'abandoned')");
    expect(sql).toContain("p_query IS NOT NULL");
    expect(sql).toContain("cardinality(COALESCE(p_query_variants, '{}'::text[])) > 0");
  });

  it("keeps lifecycle RPCs service-role-only and security-invoker", () => {
    expect(sql.match(/SECURITY INVOKER/g)).toHaveLength(2);
    expect(sql.match(/SET search_path = ''/g)).toHaveLength(2);
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.begin_search_run(text, text, text, text) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.begin_search_run(text, text, text, text) TO service_role",
    );
  });

  it("documents but does not schedule abandoned-row maintenance", () => {
    expect(sql).toContain("started_at < clock_timestamp() - interval '10 minutes'");
    expect(sql).not.toMatch(/FUNCTION\s+public\.[A-Za-z0-9_]*abandon/i);
    expect(sql).not.toMatch(/cron\.|pg_cron|CREATE\s+TRIGGER/i);
  });
});
