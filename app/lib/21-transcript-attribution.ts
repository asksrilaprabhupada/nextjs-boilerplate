/**
 * 21-transcript-attribution.ts — Presentation-only transcript attribution.
 *
 * Speaker names are evidence, not warnings. Identified speakers are displayed
 * plainly with a trailing colon; only a passage with no identified speaker
 * receives an explicit notice. This module is pure and shared by labels,
 * context framing, and copied passages so those surfaces cannot drift.
 */

import { UNKNOWN_TRANSCRIPT_SPEAKER } from "@/app/lib/15-transcript-speakers";

export const UNIDENTIFIED_SPEAKER_NOTICE =
  "Speaker not identified — part of a recorded conversation";

/**
 * `Dr. Patel` and `Dr. Patel:` both display as exactly `Dr. Patel:`. The
 * The server's compact multi-speaker value uses a middle-dot separator. Legacy
 * comma-separated values remain readable during rollout. The unknown sentinel
 * is rendered by the dedicated notice rather than as a person's name.
 */
export function transcriptSpeakerDisplays(name: string | null | undefined): string[] {
  return (name || "")
    .split(/\s+·\s+|,\s*/u)
    .map((part) => part.trim().replace(/[\s:：]+$/u, ""))
    .filter((part) => Boolean(part) && part !== UNKNOWN_TRANSCRIPT_SPEAKER)
    .map((part) => `${part}:`);
}

export function transcriptSpeakerDisplay(name: string | null | undefined): string {
  return transcriptSpeakerDisplays(name).join(" · ");
}

/**
 * Attribution lines for copied text. A mixed block may truthfully need both
 * its identified names and the one unidentified-speaker notice.
 */
export function transcriptAttributionLines(
  name: string | null | undefined,
  unidentified = !name,
): string[] {
  return [
    ...transcriptSpeakerDisplays(name),
    unidentified ? UNIDENTIFIED_SPEAKER_NOTICE : "",
  ].filter(Boolean);
}
