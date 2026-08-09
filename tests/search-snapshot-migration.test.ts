import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260803190000_search_answer_snapshots_metadata.sql",
  "utf8",
);
const rollback = readFileSync(
  "supabase/rollbacks/20260803190000_disable_search_answer_snapshots.sql",
  "utf8",
);
const provisioner = readFileSync("scripts/provision-search-snapshot-storage.mjs", "utf8");
const route = readFileSync("app/api/search/route.ts", "utf8");
const experience = readFileSync("app/components/cinematic/09-search-experience.tsx", "utf8");

describe("Phase 5 private snapshot migration", () => {
  it("stores metadata only with RLS and service-role-only grants", () => {
    expect(migration).toContain("CREATE TABLE public.search_answer_snapshots");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON TABLE public.search_answer_snapshots FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON TABLE public.search_answer_snapshots FROM anon, authenticated");
    expect(migration).toContain("REVOKE ALL ON TABLE public.search_answer_snapshots FROM service_role");
    expect(migration).toContain("GRANT SELECT, INSERT ON TABLE public.search_answer_snapshots TO service_role");
    expect(migration).toContain("interval '30 days'");
    expect(migration).not.toMatch(/\b(raw_question|answer_json|candidate_text|signed_url|visitor_id)\b/i);
    expect(migration).not.toMatch(/\b(CREATE POLICY|INSERT INTO storage\.|UPDATE storage\.|DELETE FROM storage\.)\b/i);
  });

  it("uses a non-destructive rollback and the Storage Admin API", () => {
    const executableRollback = rollback
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(rollback).toContain("REVOKE INSERT, SELECT");
    expect(executableRollback).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    expect(provisioner).toContain("client.storage.createBucket");
    expect(provisioner).toContain("public: false");
    expect(provisioner).toContain("process.argv.includes(\"--apply\")");
    expect(provisioner).not.toMatch(/storage\.(buckets|objects)/);
  });

  it("keeps ordinary requests out of capture and disables automatic behavior tracking", () => {
    expect(route).toContain("snapshotSession === null");
    expect(route).toContain("captureDiagnostics: snapshotSession !== null");
    expect(route).toContain("query: _rawQuestion");
    expect(experience).not.toContain("useSearchBehaviorTracker");
    expect(experience).not.toContain("logCitationClick");
  });
});
