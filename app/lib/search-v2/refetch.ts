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
import type { SelectedPassage } from "@/app/lib/search-v2/select";

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
  recipient: string | null;
  date: string | null;
  location: string | null;
  vedabaseUrl: string | null;
  /** Verse layers, present only for `verse`. */
  sanskrit: string | null;
  transliteration: string | null;
  synonyms: string | null;
  purport: string | null;
  selection: SelectedPassage;
}

export interface DroppedPassage {
  passageKey: string;
  reason:
    | "unknown_namespace"
    | "row_not_found"
    | "text_mismatch"
    | "empty_text"
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
    "id, scripture, verse_number, sanskrit_devanagari, transliteration, synonyms, translation, purport, vedabase_url, chapter_id",
  purport: "id, scripture, chapter_number, verse_number, chunk_number, body_text, verse_id",
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

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
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
  ctx: { requestId: string },
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
      // A failed verification read removes the items. It never falls back to the
      // unverified copy — that is precisely the thing being guarded against.
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

      // The retrieved copy is compared against the fresh row under the SAME
      // normalisation the verbatim validator uses. A difference means the row
      // changed under us, or the candidate was not what it claimed to be.
      const retrieved = g.candidate.retrieval_text || "";
      if (retrieved && normalizeVerbatim(retrieved) !== normalizeVerbatim(fresh)) {
        dropped.push({ passageKey: key, reason: "text_mismatch" });
        continue;
      }

      verified.push(buildVerified(ns, key, id, row, fresh, g));
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
    recipient: null,
    date: null,
    location: null,
    vedabaseUrl: str(row.vedabase_url),
    sanskrit: null,
    transliteration: null,
    synonyms: null,
    purport: null,
    selection,
  };

  switch (ns) {
    case "verse":
      return {
        ...base,
        reference: [str(row.scripture), str(row.verse_number)].filter(Boolean).join(" ") || null,
        sanskrit: str(row.sanskrit_devanagari),
        transliteration: str(row.transliteration),
        synonyms: str(row.synonyms),
        purport: str(row.purport),
      };
    case "purport":
      return {
        ...base,
        reference:
          [str(row.scripture), [str(row.chapter_number), str(row.verse_number)].filter(Boolean).join(".")]
            .filter(Boolean)
            .join(" ") || null,
      };
    case "book":
      return {
        ...base,
        reference: str(row.book_slug),
        vedabaseUrl: str(row.vedabase_url_precise) ?? str(row.vedabase_url),
      };
    case "lecture":
      return {
        ...base,
        reference: str(row.title) ?? str(row.content_type),
        date: str(row.date),
        location: str(row.location),
      };
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
