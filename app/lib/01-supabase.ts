/**
 * 01-supabase.ts — Supabase Client
 *
 * Creates and exports the Supabase client for both browser and server-side usage.
 * Provides the database connection used by all API routes and client-side data fetching.
 */
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wzktlpjtqmjxvragwhqg.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side client with service role key for API routes
export function createServerClient() {
  const url = process.env.SUPABASE_URL || supabaseUrl;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || "";
  return createClient(url, serviceKey);
}
