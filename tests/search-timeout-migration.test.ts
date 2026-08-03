import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260803223000_service_role_search_timeout.sql",
  "utf8",
);
const rollback = readFileSync(
  "supabase/rollbacks/20260803223000_reset_service_role_search_timeout.sql",
  "utf8",
);

describe("service-role search timeout migration", () => {
  it("raises only the service-role timeout and reloads Data API configuration", () => {
    expect(migration).toContain("ALTER ROLE service_role SET statement_timeout = '20s'");
    expect(migration).toContain("NOTIFY pgrst, 'reload config'");
    expect(migration).not.toMatch(/ALTER\s+ROLE\s+authenticator/i);
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|REINDEX)\b/i);
  });

  it("has the exact non-destructive rollback required by the phase brief", () => {
    expect(rollback).toContain("ALTER ROLE service_role RESET statement_timeout");
    expect(rollback).toContain("NOTIFY pgrst, 'reload config'");
    expect(rollback).not.toMatch(/ALTER\s+ROLE\s+authenticator/i);
  });
});
