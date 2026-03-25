/**
 * Client-side analytics helper.
 *
 * Generates anonymous session & visitor IDs, provides helpers
 * to log searches, behavior signals, and feedback votes.
 */

// ---------------------------------------------------------------------------
// Anonymous IDs
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Per-tab session ID (dies when tab closes) */
export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = sessionStorage.getItem("asp_session_id");
  if (!id) {
    id = generateId();
    sessionStorage.setItem("asp_session_id", id);
  }
  return id;
}

/** Persistent anonymous visitor ID (survives across visits via cookie) */
export function getVisitorId(): string {
  if (typeof window === "undefined") return "";

  // Try reading from cookie
  const match = document.cookie.match(/(?:^|; )asp_vid=([^;]+)/);
  if (match) return match[1];

  // Generate and store for 1 year
  const id = generateId();
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `asp_vid=${id}; expires=${expires}; path=/; SameSite=Lax`;
  return id;
}

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
// Log a search (called from search handler after results arrive)
// ---------------------------------------------------------------------------

export interface SearchLogParams {
  query: string;
  totalResults: number;
  verseIds: string[];
  proseIds: string[];
  booksReturned: string[];
  searchMethod: string;
  searchDurationMs?: number;
  embeddingDurationMs?: number;
  synthesisDurationMs?: number;
  totalDurationMs?: number;
  narrativeLength?: number;
}

/** Returns the search_log_id for later feedback/behavior calls */
export async function logSearch(params: SearchLogParams): Promise<string | null> {
  const result = await post("/api/analytics/log", {
    ...params,
    sessionId: getSessionId(),
    visitorId: getVisitorId(),
    source: /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "web",
    userAgent: navigator.userAgent,
    referrer: document.referrer || null,
  });
  return (result?.searchLogId as string) || null;
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
  followedUpQuery?: string;
}

export async function logBehavior(params: BehaviorParams): Promise<void> {
  await post("/api/analytics/behavior", params);
}