/**
 * adapt.ts — Maps pipeline output onto the wire contract.
 *
 * ONE LIST, WITH THE WORDS IN IT. The response's `passages` array carries every
 * kept passage — its exact verified text, its verse layers, its who-and-when,
 * its server-computed label, and the reranker score that kept it — in the
 * reranker's order. The page prints that list from first to last.
 *
 * This replaces the shape that caused the blank page: a `books` grouping that
 * arrived empty, a `mainFlowItems` list of bare references pointing into it,
 * and `overflow…` side-channels. The page had names and nowhere to look them
 * up. Nothing in the new shape requires a look-up: if a field is needed to
 * render a passage, it is ON the passage.
 *
 * Every string here originates from a fresh source-row read (refetch.ts) or a
 * fixed server-side table. No model output reaches this file.
 */
import type { PipelineOutput } from "@/app/lib/search-v2/pipeline";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";
import { contextNoticeFor } from "@/app/lib/search-v2/render";
import { extractQueryTerms } from "@/app/lib/10-passage-fold";
import {
  formatLabel,
  labelForWirePassage,
  purportLabelForWirePassage,
} from "@/app/lib/13-passage-label";
import type { Citation, SearchPassage, SearchResults } from "@/app/lib/types/01-search";

const CITATION_TYPE: Record<string, Citation["type"]> = {
  verse: "verse",
  purport: "verse",
  book: "prose",
  lecture: "transcript",
  letter: "letter",
};

/** One verified passage → one complete wire passage. */
export function toWirePassage(p: VerifiedPassage): SearchPassage {
  const shape = {
    type: p.sourceType,
    reference: p.reference,
    url: p.vedabaseUrl,
    scripture: p.scripture,
    division: p.division,
    chapterNumber: p.chapterNumber,
    speaker: p.speaker,
    recipient: p.recipient,
    date: p.date,
    location: p.location,
  };
  const label = labelForWirePassage(shape);
  return {
    id: p.passageKey,
    type: p.sourceType,
    reference: p.reference,
    url: p.vedabaseUrl,
    text: p.text,
    sanskrit: p.sanskrit,
    transliteration: p.transliteration,
    synonyms: p.synonyms,
    purport: p.purport,
    speaker: p.speaker,
    recipient: p.recipient,
    date: p.date,
    location: p.location,
    label: formatLabel(label),
    provenanceNote: label.provenanceNote,
    purportLabel: p.purport ? purportLabelForWirePassage(shape) : null,
    contextNotice: contextNoticeFor(p)?.text ?? null,
    rerankScore: p.selection.candidate.rerankScore ?? null,
    alsoAppearsIn: p.selection.candidate.alternates?.length ?? 0,
  };
}

/**
 * Produces the wire response. `passages` is the whole answer; everything else
 * is derived from it or is integrity metadata.
 */
export function adaptToSearchResults(query: string, out: PipelineOutput): SearchResults {
  const { article, telemetry } = out;

  const passages = out.passages.map(toWirePassage);

  const citations: Citation[] = passages.map((p) => ({
    ref: p.reference ?? p.id,
    book: p.type,
    url: p.url ?? "",
    type: CITATION_TYPE[p.type] ?? "prose",
    title: p.reference ?? "",
  }));

  return {
    query,
    passages,
    totalResults: passages.length,
    citations,
    intro: article.title,
    queryTerms: extractQueryTerms(query),
    validated: true, // every passage came out of refetchAndVerify
    droppedBlocks: telemetry.droppedOnRefetch,
    requestId: telemetry.requestId,
    retrievalStatus: "complete",
    degradedStages: telemetry.degradedStages,
    disabledLanes: [],
    // Bare row ids (never the namespaced key) — log_search stores uuid[].
    articleVerseIds: passages
      .filter((p) => p.type === "verse")
      .map((p) => p.id.slice(p.id.indexOf(":") + 1)),
  };
}
