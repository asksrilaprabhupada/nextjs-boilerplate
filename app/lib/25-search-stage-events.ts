/**
 * The public progress stream has one truthful, monotonic stage order. Keeping
 * it outside the route handler lets the browser validate incoming SSE frames
 * without giving the Next.js route file unsupported extra exports.
 */
import type { SearchStageEvent, SearchStageKey } from "@/app/lib/types/01-search";

export const SEARCH_STAGE_ORDER = [
  "understood",
  "searching",
  "reranking",
  "verifying",
  "weaving",
] as const satisfies readonly SearchStageKey[];

/** Canonical pre-result targets shared by the SSE route and loader fallback. */
export const SEARCH_STAGE_PERCENT = {
  understood: 12,
  searching: 45,
  reranking: 70,
  verifying: 84,
  weaving: 90,
} as const satisfies Record<SearchStageKey, number>;

const SEARCH_STAGE_RANK = new Map<SearchStageKey, number>(
  SEARCH_STAGE_ORDER.map((stage, index) => [stage, index]),
);

/** Validate and normalize an untrusted browser-boundary stage frame. */
export function parseSearchStageEvent(value: unknown): SearchStageEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.stage !== "string"
      || !SEARCH_STAGE_RANK.has(candidate.stage as SearchStageKey)
      || typeof candidate.pct !== "number"
      || !Number.isFinite(candidate.pct)
      || typeof candidate.label !== "string"
      || candidate.label.trim().length === 0) {
    return null;
  }

  const found = candidate.found;
  if (found !== undefined
      && (typeof found !== "number" || !Number.isFinite(found) || found < 0)) {
    return null;
  }

  return {
    stage: candidate.stage as SearchStageKey,
    // A stage frame cannot claim completion; only a delivered result can.
    pct: Math.min(99, Math.max(0, Math.round(candidate.pct))),
    label: candidate.label,
    ...(found !== undefined ? { found: Math.round(found as number) } : {}),
  };
}

/**
 * Accept richer labels/counts for the current stage and later stages, while
 * refusing to move the client backwards if a proxy ever replays an old frame.
 */
export function advanceSearchStage(
  current: SearchStageEvent | null,
  incoming: SearchStageEvent,
): SearchStageEvent {
  if (!current) return incoming;
  const currentRank = SEARCH_STAGE_RANK.get(current.stage);
  const incomingRank = SEARCH_STAGE_RANK.get(incoming.stage);
  if (currentRank === undefined || incomingRank === undefined || incomingRank < currentRank) {
    return current;
  }
  return { ...incoming, pct: Math.max(current.pct, incoming.pct) };
}
