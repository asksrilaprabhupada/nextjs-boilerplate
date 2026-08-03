import type { DegradedSource } from "@/app/lib/types/01-search";

function friendlyList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Stable public copy: no internal source, provider, code or error can enter it. */
export function incompleteSearchWarning(sources: readonly DegradedSource[]): string {
  const unavailable = [...new Set(sources
    .filter((item) => item.reason === "temporarily unavailable")
    .map((item) => item.source))];
  const partial = [...new Set(sources
    .filter((item) => item.reason === "some passages could not be verified")
    .map((item) => item.source))]
    .filter((source) => !unavailable.includes(source));
  if (unavailable.length === 0 && partial.length === 0) return "";

  const clauses: string[] = [];
  if (unavailable.length > 0) {
    clauses.push(`${friendlyList(unavailable)} could not be searched this time.`);
  }
  if (partial.length > 0) {
    clauses.push(`Some passages from ${friendlyList(partial.map((name) => name.toLocaleLowerCase("en")))} could not be verified.`);
  }
  return `${clauses.join(" ")} This answer is incomplete. Please search again.`;
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
