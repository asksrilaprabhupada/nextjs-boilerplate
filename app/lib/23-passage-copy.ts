/**
 * 23-passage-copy.ts — Pure copied-passage formatter.
 *
 * The visible label is not guaranteed to travel with clipboard text, so a
 * recorded-talk copy carries either the identified speaker or the explicit
 * unidentified-speaker notice. Passage words themselves are passed through
 * unchanged apart from the existing outer trim performed by the caller.
 */
import { transcriptAttributionLines } from "@/app/lib/21-transcript-attribution";

export interface PassageCopyInput {
  type: "verse" | "purport" | "book" | "lecture" | "letter";
  text: string;
  speaker: string | null;
  speakerUnidentified?: boolean;
  citation: string;
  url: string | null;
}

export function buildPassageCopyText(input: PassageCopyInput): string {
  const attribution = input.type === "lecture"
    ? transcriptAttributionLines(
        input.speaker,
        input.speakerUnidentified ?? !input.speaker,
      )
    : [];
  const reference = `— ${input.citation}${input.url ? `\n${input.url}` : ""}`;
  return [...attribution, `"${input.text}"`, reference].filter(Boolean).join("\n\n");
}
