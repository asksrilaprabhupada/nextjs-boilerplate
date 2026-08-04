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
import {
  FILTERED_TRANSCRIPT_VERIFICATION_PARTIAL_CODE,
  type AdditionalPassage,
  type PipelineOutput,
  type SearchTelemetry,
} from "@/app/lib/search-v2/pipeline";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";
import { contextNoticeFor } from "@/app/lib/search-v2/render";
import { extractQueryTerms } from "@/app/lib/10-passage-fold";
import { vedabaseUrlForReference } from "@/app/lib/05-link-postprocessor";
import {
  formatLabel,
  labelForWirePassage,
  labelForAdditionalPassage,
  purportLabelForWirePassage,
} from "@/app/lib/13-passage-label";
import type {
  AdditionalSearchPassage,
  DegradedSource,
  Citation,
  SearchPassage,
  SearchResults,
} from "@/app/lib/types/01-search";

export function degradedSourcesForWire(
  telemetry: Pick<SearchTelemetry, "degradedSources" | "degradedStages">,
): DegradedSource[] {
  const unavailable = new Set(telemetry.degradedSources);
  const out: DegradedSource[] = [...unavailable].map((source) => ({
    source,
    reason: "temporarily unavailable",
  }));
  const transcriptVerificationPartial = telemetry.degradedStages.some(
    (item) => item.code === FILTERED_TRANSCRIPT_VERIFICATION_PARTIAL_CODE,
  );
  if (transcriptVerificationPartial && !unavailable.has("Lectures and conversations")) {
    out.push({
      source: "Lectures and conversations",
      reason: "some passages could not be verified",
    });
  }
  return out;
}

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
    speakerConfidence: p.speakerConfidence,
    speakerUnidentified: p.speakerConfidence === "unknown",
    recipient: p.recipient,
    date: p.date,
    location: p.location,
  };
  const label = labelForWirePassage(shape);
  return {
    type: p.sourceType,
    reference: p.reference,
    url: p.vedabaseUrl,
    text: p.text,
    sanskrit: p.sanskrit,
    transliteration: p.transliteration,
    synonyms: p.synonyms,
    purport: p.purport,
    speaker: p.speaker,
    speakerUnidentified: p.speakerConfidence === "unknown",
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

/** One pipeline second-tier entry → one wire citation line. */
export function toWireAdditional(a: AdditionalPassage): AdditionalSearchPassage {
  const type = a.sourceType as AdditionalSearchPassage["type"];
  const shape = {
    type,
    reference: a.reference,
    speaker: a.speaker,
    speakerUnidentified: a.speakerUnidentified,
    recipient: a.recipient,
    date: a.occurredOn,
    location: a.location,
  };
  const label = labelForAdditionalPassage(shape);
  return {
    type,
    reference: a.reference,
    // Derived from the reference when it parses cleanly (verses/purports);
    // the second-tier pipeline does not carry stored source URLs to this adapter.
    url: type === "verse" || type === "purport" ? vedabaseUrlForReference(a.reference) : null,
    label: formatLabel(label),
    provenanceNote: label.provenanceNote,
    snippet: a.snippet,
    speaker: a.speaker,
    speakerUnidentified: a.speakerUnidentified,
    recipient: a.recipient,
    date: a.occurredOn,
    location: a.location,
    rerankScore: a.rerankScore,
  };
}

/**
 * Produces the wire response. `passages` (the main tier) plus `additional`
 * (everything else that survived retrieval) are the whole answer; everything
 * else is derived from them or is integrity metadata.
 */
export function adaptToSearchResults(query: string, out: PipelineOutput): SearchResults {
  const { article, telemetry } = out;

  const passages = out.passages.map(toWirePassage);
  const additional = out.additional.map(toWireAdditional);
  const degradedSources = degradedSourcesForWire(telemetry);

  const citations: Citation[] = passages.map((p) => ({
    ref: p.reference ?? p.label,
    book: p.type,
    url: p.url ?? "",
    type: CITATION_TYPE[p.type] ?? "prose",
    title: p.reference ?? "",
  }));

  return {
    query,
    passages,
    additional,
    additionalCount: additional.length,
    // The honest total: what is rendered in full plus what is cited.
    totalResults: passages.length + additional.length,
    citations,
    intro: article.title,
    queryTerms: extractQueryTerms(query),
    speakerFilter: telemetry.speakerFilter.mode,
    validated: true, // every passage came out of refetchAndVerify
    droppedBlocks: telemetry.droppedOnRefetch,
    requestId: telemetry.requestId,
    degraded: telemetry.degraded,
    retrievalStatus: degradedSources.length > 0 ? "degraded" : "complete",
    degradedSources,
    disabledLanes: [],
  };
}
