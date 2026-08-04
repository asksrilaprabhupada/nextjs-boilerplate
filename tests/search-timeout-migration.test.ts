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
    expect(migration).toContain("pg_catalog.pg_db_role_setting");
    expect(migration).toContain("service_role already has an explicit statement_timeout");
    expect(migration).toContain("ALTER ROLE service_role SET statement_timeout = '20s'");
    expect(migration).toContain("NOTIFY pgrst, 'reload config'");
    expect(migration.match(/ALTER\s+ROLE/gi)).toHaveLength(1);
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|CREATE\s+POLICY|ALTER\s+TABLE)\b/i);
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|REINDEX)\b/i);
  });

  it("has the exact non-destructive rollback required by the phase brief", () => {
    expect(rollback).toContain("ALTER ROLE service_role RESET statement_timeout");
    expect(rollback).toContain("NOTIFY pgrst, 'reload config'");
    const executable = rollback
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim();
    expect(executable).toBe(
      "ALTER ROLE service_role RESET statement_timeout;\n\nNOTIFY pgrst, 'reload config';",
    );
  });
});
