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
import {
  DefiniteSupabaseTransportError,
  transientTransportCodeFromFetchRejection,
} from "@/app/lib/search-v2/rpc";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || "";

let client: SupabaseClient | null = null;

/**
 * Brands only native fetch rejections that happened before a Response existed.
 * Supabase/PostgREST resolved errors, response-body failures, application aborts
 * and unknown exceptions remain unbranded and can never enter the retry path.
 */
async function fetchWithTransportEvidence(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    if (init?.signal?.aborted) throw cause;
    const code = transientTransportCodeFromFetchRejection(cause);
    if (!code) throw cause;
    throw new DefiniteSupabaseTransportError(code, cause);
  }
}

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
      { stage: "config", source: "supabase", attemptCount: 0 },
    );
  }
  if (!client) {
    client = createClient(supabaseUrl, supabaseServiceKey, {
      global: { fetch: fetchWithTransportEvidence },
    });
  }
  return client;
}

/**
 * Creates a service-role client whose individual HTTP requests are aborted at
 * the supplied deadline. Snapshot persistence uses this instead of the shared
 * retrieval client so a slow optional write can never hold the search open.
 */
export function createBoundedSupabaseAdmin(timeoutMs: number): SupabaseClient {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new SearchInfrastructureError(
      `Supabase server credentials missing (url: ${supabaseUrl ? "set" : "absent"}, service key: ${supabaseServiceKey ? "set" : "absent"})`,
      { stage: "config", source: "supabase", attemptCount: 0 },
    );
  }
  const boundedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const upstream = init?.signal;
    const abortFromUpstream = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) abortFromUpstream();
    else upstream?.addEventListener("abort", abortFromUpstream, { once: true });
    try {
      return await fetchWithTransportEvidence(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", abortFromUpstream);
    }
  };
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { fetch: boundedFetch },
  });
}
