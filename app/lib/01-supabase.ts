/**
 * 01-supabase.ts — Supabase Admin Client
 *
 * Single source of truth for the server-side Supabase connection. Exposes one
 * lazily-instantiated client configured with the service-role key, shared by
 * every API route so connection setup is never duplicated.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

let client: SupabaseClient | null = null;

/**
 * Returns the shared server-side Supabase client, creating it on first use.
 * Uses the service-role key so API routes can read and write every table.
 * Instantiation is deferred (not at module load) so the build never fails
 * when environment variables are absent.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(supabaseUrl, supabaseServiceKey);
  }
  return client;
}
