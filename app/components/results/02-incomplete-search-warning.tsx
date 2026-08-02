import type { DegradedSource } from "@/app/lib/types/01-search";

function friendlyList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Stable public copy: no internal source, provider, code or error can enter it. */
export function incompleteSearchWarning(sources: readonly DegradedSource[]): string {
  const names = [...new Set(sources.map((item) => item.source))];
  if (names.length === 0) return "";
  return `${friendlyList(names)} could not be searched this time. This answer is incomplete. Please search again.`;
}

export default function IncompleteSearchWarning({ sources }: { sources: readonly DegradedSource[] }) {
  const message = incompleteSearchWarning(sources);
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
