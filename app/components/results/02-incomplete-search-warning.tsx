import type { DegradedSource } from "@/app/lib/types/01-search";

function friendlyList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Stable public copy: no internal source, provider, code or error can enter it. */
export function incompleteSearchWarning(
  sources: readonly DegradedSource[],
  degraded = sources.length > 0,
): string {
  const unavailable = [...new Set(sources.map((item) => item.source))];
  if (unavailable.length === 0) {
    return degraded
      ? "Some search guidance was unavailable this time. This answer may be less complete. Please search again."
      : "";
  }

  return `${friendlyList(unavailable)} could not be searched this time. This answer is incomplete. Please search again.`;
}

export default function IncompleteSearchWarning({
  sources,
  degraded = sources.length > 0,
}: {
  sources: readonly DegradedSource[];
  degraded?: boolean;
}) {
  const message = incompleteSearchWarning(sources, degraded);
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
