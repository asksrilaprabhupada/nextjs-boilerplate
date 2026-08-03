/**
 * refetch.ts — The hard stop. Nothing is displayed that did not come from here.
 *
 * After planning and selection, every chosen passage is re-read from the source
 * row and re-verified. The renderer is then given ONLY this fresh data. No
 * quotation text, citation, speaker, recipient or date ever reaches a devotee on
 * the authority of a model, a cache, or a retrieval payload.
 *
 * The rule this enforces, from the brief:
 *
 *     "A misattributed passage is the one failure that cannot be undone.
 *      Everything else is recoverable."
 *
 * So the failure mode is deletion, never approximation. A passage whose text no
 * longer byte-matches, whose id does not resolve, or whose id resolves to the
 * wrong table is DROPPED and recorded. It is never repaired, never substituted,
 * and never rendered from the stale copy.
 *
 * `passage_key` is namespaced (`verse:<uuid>`), and the prefix is what decides
 * which table is read. A key claiming to be a verse that resolves to a letter
 * row is exactly the confusion this guards against.
 */
import { unwrapOrThrow, type RpcCapableClient } from "@/app/lib/search-v2/rpc";
import { normalizeVerbatim } from "@/app/lib/17-verbatim-validator";
import { formatVerseReference } from "@/app/lib/search-v2/citation";
import type { SelectedPassage } from "@/app/lib/search-v2/select";
import type { RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import { fullSha256 } from "@/app/lib/search-v2/cache";
import {
  projectPrabhupadaSegments,
  transcriptSpeakerAttribution,
} from "@/app/lib/15-transcript-speakers";

/** Namespace → the table and columns that namespace is allowed to resolve to. */
const SOURCE_TABLES = {
  verse: { table: "verses", textColumn: "translation" },
  purport: { table: "verse_chunks", textColumn: "body_text" },
  book: { table: "prose_paragraphs", textColumn: "body_text" },
  lecture: { table: "transcript_paragraphs", textColumn: "body_text" },
  letter: { table: "letter_paragraphs", textColumn: "body_text" },
} as const;

export type SourceNamespace = keyof typeof SOURCE_TABLES;

export function isSourceNamespace(v: string): v is SourceNamespace {
  return Object.prototype.hasOwnProperty.call(SOURCE_TABLES, v);
}

/** Verified passage data. The renderer may use nothing else. */
export interface VerifiedPassage {
  passageKey: string;
  sourceType: SourceNamespace;
  rowId: string;
  /** Exact stored text, straight from the source row. */
  text: string;
  reference: string | null;
  speaker: string | null;
  /**
   * How the speaker value was established (transcripts only):
   * 'labelled' — an explicit "Name:" prefix in the source text;
   * 'unknown'  — no label; NOT assumed to be Śrīla Prabhupāda's words.
   * ('inherited' is reserved for a future continuation-paragraph pass.)
   */
  speakerConfidence: "labelled" | "inherited" | "unknown" | null;
  recipient: string | null;
  date: string | null;
  location: string | null;
  vedabaseUrl: string | null;
  /** Verse layers, present only for `verse`. */
  sanskrit: string | null;
  transliteration: string | null;
  synonyms: string | null;
  purport: string | null;
  /**
   * Raw citation pieces from the fresh row (verse/purport only), so downstream
   * provenance labelling never has to re-parse the formatted reference.
   */
  scripture: string | null;
  division: string | null;
  chapterNumber: number | null;
  selection: SelectedPassage;
}

export interface DroppedPassage {
  passageKey: string;
  reason:
    | "unknown_namespace"
    | "row_not_found"
    | "text_mismatch"
    | "empty_text"
    | "speaker_projection_missing"
    | "speaker_projection_mismatch"
    | "speaker_projection_empty"
    | "fetch_failed";
}

export interface RefetchResult {
  verified: VerifiedPassage[];
  dropped: DroppedPassage[];
  /** Table reads issued. Reported separately from the five retrieval RPCs. */
  fetchCount: number;
}

interface SupabaseLike extends RpcCapableClient {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

const COLUMNS: Record<SourceNamespace, string> = {
  verse:
    "id, scripture, verse_number, sanskrit_devanagari, transliteration, synonyms, translation, purport, vedabase_url, chapter_id, chapters(chapter_number, canto_or_division)",
  // The parent verse carries the canonical Vedabase URL and the chapter row
  // carries the SB canto / CC division, both of which the citation needs.
  purport:
    "id, scripture, chapter_number, verse_number, chunk_number, body_text, verse_id, verses(vedabase_url, chapters(chapter_number, canto_or_division))",
  book: "id, book_slug, paragraph_number, body_text, vedabase_url, vedabase_url_precise, chapter_id",
  lecture:
    "id, title, content_type, date, location, occasion, scripture_ref, body_text, vedabase_url, transcript_id",
  letter: "id, title, date, location, recipient, body_text, vedabase_url, letter_id",
};

function parseKey(key: string): { ns: string; id: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return { ns: key.slice(0, idx), id: key.slice(idx + 1) };
}

/**
 * PostgREST returns an embedded resource as an object for a to-one join and as
 * an array for a to-many one. Normalising here keeps the callers readable.
 */
function nested(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? null;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function verifySpeakerProjection(
  candidate: RetrievedCandidate,
  fresh: string,
): { text: string; reason: null } | { text: null; reason: DroppedPassage["reason"] } {
  const marker = candidate.speakerProjection;
  if (!marker || marker.mode !== "prabhupada_segments") {
    return { text: null, reason: "speaker_projection_missing" };
  }
  if (marker.sourceVerificationHash !== fullSha256(fresh)) {
    return { text: null, reason: "speaker_projection_mismatch" };
  }
  const projection = projectPrabhupadaSegments(fresh);
  if (!projection.text) return { text: null, reason: "speaker_projection_empty" };
  if (projection.text !== (candidate.retrieval_text || "")) {
    return { text: null, reason: "speaker_projection_mismatch" };
  }
  return { text: projection.text, reason: null };
}

/**
 * Re-reads every selected passage and verifies it.
 *
 * One query per namespace, not one per passage: the point is verification, not
 * pathological round trips. The count is reported so the "five RPCs" claim
 * stays honest.
 */
export async function refetchAndVerify(
  db: SupabaseLike,
  selected: SelectedPassage[],
  ctx: { requestId: string; speakerOnly?: boolean },
): Promise<RefetchResult> {
  const verified: VerifiedPassage[] = [];
  const dropped: DroppedPassage[] = [];
  let fetchCount = 0;

  const byNamespace = new Map<SourceNamespace, SelectedPassage[]>();
  for (const s of selected) {
    const parsed = parseKey(s.candidate.passage_key);
    if (!parsed || !isSourceNamespace(parsed.ns)) {
      dropped.push({ passageKey: s.candidate.passage_key, reason: "unknown_namespace" });
      continue;
    }
    const list = byNamespace.get(parsed.ns) ?? [];
    list.push(s);
    byNamespace.set(parsed.ns, list);
  }

  for (const [ns, group] of byNamespace) {
    const ids = group
      .map((g) => parseKey(g.candidate.passage_key)?.id)
      .filter((v): v is string => Boolean(v));
    if (ids.length === 0) continue;

    let rows: Record<string, unknown>[];
    try {
      fetchCount += 1;
      const result = await db.from(SOURCE_TABLES[ns].table).select(COLUMNS[ns]).in("id", ids);
      rows = unwrapOrThrow<Record<string, unknown>[]>(result, `refetch:${ns}`, {
        stage: "verify:refetch",
        requestId: ctx.requestId,
      });
    } catch {
      // A failed verification read removes the items. It never falls back to
      // the retrieval copy or retries a schema variant — body_text itself is
      // the attribution authority and needs no speaker columns.
      for (const g of group) {
        dropped.push({ passageKey: g.candidate.passage_key, reason: "fetch_failed" });
      }
      continue;
    }

    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows ?? []) {
      const id = str(r.id);
      if (id) byId.set(id, r);
    }

    for (const g of group) {
      const key = g.candidate.passage_key;
      const id = parseKey(key)?.id ?? "";
      const row = byId.get(id);

      if (!row) {
        dropped.push({ passageKey: key, reason: "row_not_found" });
        continue;
      }

      const fresh = str(row[SOURCE_TABLES[ns].textColumn]);
      if (!fresh) {
        dropped.push({ passageKey: key, reason: "empty_text" });
        continue;
      }

      const retrieved = g.candidate.retrieval_text || "";
      let verifiedText = fresh;
      if (ns === "lecture" && ctx.speakerOnly) {
        const projection = verifySpeakerProjection(g.candidate, fresh);
        if (projection.reason) {
          dropped.push({ passageKey: key, reason: projection.reason });
          continue;
        }
        verifiedText = projection.text;
      } else {
        // The retrieved copy is compared against the fresh row under the SAME
        // cosmetic normalisation the verbatim validator uses. A difference
        // means the row changed under us, or the candidate was misidentified.
        if (retrieved && normalizeVerbatim(retrieved) !== normalizeVerbatim(fresh)) {
          dropped.push({ passageKey: key, reason: "text_mismatch" });
          continue;
        }
      }

      verified.push(buildVerified(ns, key, id, row, verifiedText, g));
    }
  }

  if (dropped.length > 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "search.refetch_dropped",
        requestId: ctx.requestId,
        dropped: dropped.map((d) => ({ reason: d.reason })),
      }),
    );
  }

  // Preserve the selector's order, which the renderer depends on.
  const order = new Map(selected.map((s, i) => [s.candidate.passage_key, i]));
  verified.sort((a, b) => (order.get(a.passageKey) ?? 0) - (order.get(b.passageKey) ?? 0));

  return { verified, dropped, fetchCount };
}

export interface FilteredTranscriptVerification {
  textByPassageKey: Map<string, string>;
  dropped: DroppedPassage[];
  fetchCount: number;
}

/**
 * The additional tier normally carries retrieval previews. In speaker-only
 * mode its transcript previews receive the same fresh-row projection proof as
 * main-tier blocks, in one bounded table read, so a stale mixed block can never
 * re-enter through a snippet.
 */
export async function refetchAndVerifyFilteredTranscripts(
  db: SupabaseLike,
  candidates: RetrievedCandidate[],
  ctx: { requestId: string },
): Promise<FilteredTranscriptVerification> {
  const transcripts = candidates.filter((candidate) => candidate.source_type === "lecture");
  const textByPassageKey = new Map<string, string>();
  const dropped: DroppedPassage[] = [];
  if (transcripts.length === 0) return { textByPassageKey, dropped, fetchCount: 0 };

  const ids = [...new Set(transcripts.map((candidate) => parseKey(candidate.passage_key)?.id)
    .filter((id): id is string => Boolean(id)))];
  let rows: Record<string, unknown>[];
  try {
    const result = await db.from(SOURCE_TABLES.lecture.table).select(COLUMNS.lecture).in("id", ids);
    rows = unwrapOrThrow<Record<string, unknown>[]>(result, "refetch:lecture:additional", {
      stage: "verify:refetch_additional",
      requestId: ctx.requestId,
    });
  } catch {
    for (const candidate of transcripts) {
      dropped.push({ passageKey: candidate.passage_key, reason: "fetch_failed" });
    }
    return { textByPassageKey, dropped, fetchCount: 1 };
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows ?? []) {
    const id = str(row.id);
    if (id) byId.set(id, row);
  }

  for (const candidate of transcripts) {
    const parsed = parseKey(candidate.passage_key);
    const row = parsed ? byId.get(parsed.id) : null;
    if (!row) {
      dropped.push({ passageKey: candidate.passage_key, reason: "row_not_found" });
      continue;
    }
    const fresh = str(row.body_text);
    if (!fresh) {
      dropped.push({ passageKey: candidate.passage_key, reason: "empty_text" });
      continue;
    }
    const projection = verifySpeakerProjection(candidate, fresh);
    if (projection.reason) {
      dropped.push({ passageKey: candidate.passage_key, reason: projection.reason });
      continue;
    }
    textByPassageKey.set(candidate.passage_key, projection.text);
  }

  if (dropped.length > 0) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "search.additional_transcript_refetch_dropped",
      requestId: ctx.requestId,
      dropped: dropped.map((item) => ({ reason: item.reason })),
    }));
  }

  return { textByPassageKey, dropped, fetchCount: 1 };
}

function buildVerified(
  ns: SourceNamespace,
  passageKey: string,
  rowId: string,
  row: Record<string, unknown>,
  text: string,
  selection: SelectedPassage,
): VerifiedPassage {
  const base: VerifiedPassage = {
    passageKey,
    sourceType: ns,
    rowId,
    text,
    reference: null,
    speaker: null,
    speakerConfidence: null,
    recipient: null,
    date: null,
    location: null,
    vedabaseUrl: str(row.vedabase_url),
    sanskrit: null,
    transliteration: null,
    synonyms: null,
    purport: null,
    scripture: null,
    division: null,
    chapterNumber: null,
    selection,
  };

  switch (ns) {
    case "verse": {
      const ch = nested(row.chapters);
      const chapterNumber = (ch?.chapter_number as number | null) ?? null;
      return {
        ...base,
        reference: formatVerseReference({
          scripture: str(row.scripture),
          division: str(ch?.canto_or_division),
          chapterNumber,
          verseNumber: str(row.verse_number),
          vedabaseUrl: str(row.vedabase_url),
        }),
        sanskrit: str(row.sanskrit_devanagari),
        transliteration: str(row.transliteration),
        synonyms: str(row.synonyms),
        purport: str(row.purport),
        scripture: str(row.scripture),
        division: str(ch?.canto_or_division),
        chapterNumber,
      };
    }
    case "purport": {
      const parent = nested(row.verses);
      const ch = nested(parent?.chapters);
      const chapterNumber =
        (ch?.chapter_number as number | null) ?? (row.chapter_number as number | null) ?? null;
      return {
        ...base,
        reference: formatVerseReference({
          scripture: str(row.scripture),
          division: str(ch?.canto_or_division),
          chapterNumber,
          verseNumber: str(row.verse_number),
          vedabaseUrl: str(parent?.vedabase_url),
        }),
        vedabaseUrl: str(parent?.vedabase_url),
        scripture: str(row.scripture),
        division: str(ch?.canto_or_division),
        chapterNumber,
      };
    }
    case "book":
      return {
        ...base,
        reference: str(row.book_slug),
        vedabaseUrl: str(row.vedabase_url_precise) ?? str(row.vedabase_url),
      };
    case "lecture": {
      const attribution = transcriptSpeakerAttribution(text);
      return {
        ...base,
        reference: str(row.title) ?? str(row.content_type),
        date: str(row.date),
        location: str(row.location),
        speaker: attribution.displaySpeaker,
        speakerConfidence: attribution.confidence,
      };
    }
    case "letter":
      return {
        ...base,
        reference: str(row.title) ?? "Letter",
        date: str(row.date),
        location: str(row.location),
        recipient: str(row.recipient),
      };
  }
}

/**
 * A letter must never be rendered without a verified recipient AND date. The
 * selector already excludes unlabellable letters; this is the second gate,
 * applied after the fresh read, because the retrieval copy is not authority.
 */
export function isRenderable(p: VerifiedPassage): boolean {
  if (p.sourceType === "letter") return Boolean(p.recipient) && Boolean(p.date);
  return true;
}
