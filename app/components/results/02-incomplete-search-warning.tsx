import type { DegradedSource } from "@/app/lib/types/01-search";

function friendlyList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * The one line a devotee reads when the ranking did not complete.
 *
 * It says what is actually true: the library WAS searched, every passage is
 * real, and only the ordering is missing. Saying "this answer is incomplete"
 * here would be false — nothing was left out — and saying nothing at all is
 * how an unranked page passed for a ranked one.
 */
export const RANKING_UNAVAILABLE_MESSAGE =
  "The library search completed, but final relevance ranking was temporarily unavailable. "
  + "You may retry for the best ordering.";

/** Stable public copy: no internal source, provider, code or error can enter it. */
export function incompleteSearchWarning(
  sources: readonly DegradedSource[],
  degraded = sources.length > 0,
  rankingUnavailable = false,
): string {
  const unavailable = [...new Set(sources.map((item) => item.source))];
  if (unavailable.length === 0) {
    // A failed ranking is named specifically. Only a degradation we cannot
    // name falls through to the general sentence.
    if (rankingUnavailable) return RANKING_UNAVAILABLE_MESSAGE;
    return degraded
      ? "Some search guidance was unavailable this time. This answer may be less complete. Please search again."
      : "";
  }

  const sourceLine =
    `${friendlyList(unavailable)} could not be searched this time. This answer is incomplete. Please search again.`;
  // Both can fail at once, and each is a separate fact the reader needs.
  return rankingUnavailable ? `${sourceLine} ${RANKING_UNAVAILABLE_MESSAGE}` : sourceLine;
}

export default function IncompleteSearchWarning({
  sources,
  degraded = sources.length > 0,
  rankingUnavailable = false,
}: {
  sources: readonly DegradedSource[];
  degraded?: boolean;
  rankingUnavailable?: boolean;
}) {
  const message = incompleteSearchWarning(sources, degraded, rankingUnavailable);
  if (!message) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="font-body"
      style={{
        margin: "0 0 clamp(28px,5vh,42px)",
        padding: "16px 18px",
        border: "2px solid #C48B16",
        borderRadius: 12,
        background: "#FFF4CF",
        color: "#4D3505",
        fontSize: 15,
        fontWeight: 650,
        lineHeight: 1.55,
      }}
    >
      {message}
    </div>
  );
}
