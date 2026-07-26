/**
 * 01-supabase.ts — Supabase Admin Client
 *
 * Single source of truth for the server-side Supabase connection. Exposes one
 * lazily-instantiated client configured with the service-role key, shared by
 * every API route so connection setup is never duplicated.
 *
 * The service key is REQUIRED. This module previously fell back to the public
 * anon key, which meant a deploy missing SUPABASE_SERVICE_KEY kept working but
 * silently ran under RLS — reads returned nothing and writes were refused, and
 * both looked like ordinary empty results. Now a missing key raises a typed
 * infrastructure error at request time. The URL still falls back to the
 * NEXT_PUBLIC_ variable because it is genuinely public and identical.
 *
 * Instantiation stays lazy so builds without runtime credentials succeed.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SearchInfrastructureError } from "@/app/lib/search-v2/errors";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || "";

let client: SupabaseClient | null = null;

/** True when the server credentials needed to serve a request are present. */
export function hasSupabaseCredentials(): boolean {
  return Boolean(supabaseUrl) && Boolean(supabaseServiceKey);
}

/**
 * Returns the shared server-side Supabase client, creating it on first use.
 *
 * @throws SearchInfrastructureError when the URL or service-role key is absent,
 * so misconfiguration surfaces as a 503 with a request id rather than as an
 * empty search result.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new SearchInfrastructureError(
      `Supabase server credentials missing (url: ${supabaseUrl ? "set" : "absent"}, service key: ${supabaseServiceKey ? "set" : "absent"})`,
      { stage: "config" },
    );
  }
  if (!client) {
    client = createClient(supabaseUrl, supabaseServiceKey);
  }
  return client;
}
