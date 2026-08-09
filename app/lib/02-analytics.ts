/**
 * 02-analytics.ts — Analytics Helpers
 *
 * Provides feedback and bounded result-interaction helpers.
 * Search questions are logged server-side as hashes; this module deliberately
 * has no raw-query logger or persistent visitor-ID creator.
 */

// ---------------------------------------------------------------------------
// API helpers (fire-and-forget — never block the UI)
// ---------------------------------------------------------------------------

async function post(path: string, body: Record<string, unknown> | object): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Record feedback vote
// ---------------------------------------------------------------------------

export async function logFeedback(
  searchLogId: string,
  vote: 1 | -1,
  text?: string
): Promise<boolean> {
  const result = await post("/api/analytics/feedback", {
    searchLogId,
    vote,
    text: text || null,
  });
  return result !== null;
}

// ---------------------------------------------------------------------------
// Record behavior signals (call periodically or on page leave)
// ---------------------------------------------------------------------------

export interface BehaviorParams {
  searchLogId: string;
  clickedCitations?: string[];
  clickedWantMore?: string[];
  scrolledToBottom?: boolean;
  timeOnResultMs?: number;
}

/**
 * Beacon-first delivery so signals survive page unload (sendBeacon queues the
 * POST even as the document tears down); falls back to keepalive fetch.
 */
function beacon(path: string, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const ok = navigator.sendBeacon(path, new Blob([payload], { type: "application/json" }));
      if (ok) return;
    }
  } catch { /* fall through to fetch */ }
  void fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => { /* fire-and-forget */ });
}

export function logBehavior(params: BehaviorParams): void {
  beacon("/api/analytics/behavior", { ...params });
}

// ---------------------------------------------------------------------------
// Record a Vedabase citation click (dedicated citation_clicks table)
// ---------------------------------------------------------------------------

export interface CitationClickParams {
  searchLogId: string;
  verseId?: string | null;
  proseId?: string | null;
  citationRef?: string | null;
  bookSlug?: string | null;
  clickPosition?: number | null;
}

export function logCitationClick(params: CitationClickParams): void {
  beacon("/api/analytics/citation-click", { ...params });
}
