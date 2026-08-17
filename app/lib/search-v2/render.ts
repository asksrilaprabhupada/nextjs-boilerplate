/**
 * render.ts — Framing a passage cannot be shown without.
 *
 * This file used to be the article renderer: headings, transitions, a source
 * map, a closing, a deterministic title, and the machinery for arranging
 * passages into sections from a Gemini plan. All of it is gone, with the
 * organizing call itself, and the reason is worth recording.
 *
 * The arrangement never reached the page. `PipelineOutput.passages` has always
 * been the SELECTOR's list, in the reranker's order, and that is what the
 * browser prints — the rendered sections were built, measured for telemetry,
 * and then dropped. The only output that ever reached a devotee was the
 * planner's `title`, printed as a framing note above the answer. A page that
 * carries only Śrīla Prabhupāda's words should not open with a sentence Gemini
 * wrote about them, and it should not spend seconds per search buying one.
 *
 * What remains is the one thing that was never the planner's: the notice a
 * letter must carry. Correspondence to one person on one date is not a general
 * rule, and an unlabelled letter reads as if it were.
 */
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";

export type ContextNoticeKind = "letter" | "conversation" | "narrative";

function year(date: string | null): string {
  if (!date) return "";
  const m = date.match(/^(\d{4})/);
  return m ? m[1] : date;
}

export function contextNoticeFor(p: VerifiedPassage): { text: string; kind: ContextNoticeKind } | null {
  switch (p.sourceType) {
    case "letter":
      // Guarded by isRenderable, but re-checked: an unlabelled letter must never
      // reach a reader looking like general instruction.
      if (!p.recipient || !p.date) return null;
      return {
        text: `Specific correspondence — Letter to ${p.recipient}, ${year(p.date)}`,
        kind: "letter",
      };
    case "lecture":
      // The server-computed label already shows either `Name:` or the single
      // unidentified-speaker notice. A second context line would duplicate the
      // same attribution immediately below it.
      return null;
    default:
      return null;
  }
}
