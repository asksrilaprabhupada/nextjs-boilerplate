/**
 * source-url.ts — The stored Vedabase URL for every SECOND-TIER passage.
 *
 * The main tier already carries its link: refetch.ts re-reads each rendered
 * passage in full and takes `vedabase_url` off that fresh row. The citation
 * tier never had one. It is not re-fetched (it shows no body text, so there is
 * nothing to verify), and the five retrieval RPCs do not return the URL column,
 * so `adapt.ts` could only ever rebuild a link from the reference — which works
 * for verses and purports and yields null for everything else. That is why a
 * lecture, a letter, or a book paragraph in Dig Deeper had no "Open source"
 * button while its URL sat in the database all along.
 *
 * This reads that one column back. It is a link lookup, NOT a verification
 * read: it never contributes text, speaker, date, or reference, so it cannot
 * put an unverified word in front of a devotee. The worst it can do is fail,
 * and a failure costs a button, not a passage.
 *
 * Three rules hold the honesty line:
 *
 *   - Never invent a URL. `verse_chunks` stores none, so the parent verse is
 *     joined and its URL used; a row with nothing usable stays null and the
 *     button simply does not render.
 *   - Book prose prefers `vedabase_url_precise` — the paragraph anchor — and
 *     falls back to the chapter-level `vedabase_url`.
 *   - A failed read is not fatal and is never retried into a guess. The caller
 *     keeps whatever came back and lets the rest fall through to null.
 */
import { unwrapOrThrow, type RpcCapableClient } from "@/app/lib/search-v2/rpc";
import { isSourceNamespace, type SourceNamespace } from "@/app/lib/search-v2/refetch";

/**
 * Namespace → the id and URL columns that namespace is allowed to read. The
 * tables match refetch.ts exactly; a namespace may never read another's table.
 */
const URL_COLUMNS: Record<SourceNamespace, string> = {
  verse: "id, vedabase_url",
  // verse_chunks has no URL column of its own: the parent verse owns it.
  purport: "id, verses(vedabase_url)",
  // The precise anchor points at the paragraph; vedabase_url only at the page.
  book: "id, vedabase_url, vedabase_url_precise",
  lecture: "id, vedabase_url",
  letter: "id, vedabase_url",
};

const URL_TABLES: Record<SourceNamespace, string> = {
  verse: "verses",
  purport: "verse_chunks",
  book: "prose_paragraphs",
  lecture: "transcript_paragraphs",
  letter: "letter_paragraphs",
};

interface SupabaseLike extends RpcCapableClient {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

export interface SourceUrlResult {
  /** passage_key → stored URL. A key is absent when nothing usable was found. */
  urls: Map<string, string>;
  /** Table reads issued, so the "five RPCs" accounting stays honest. */
  fetchCount: number;
  /** Namespaces whose read failed. Their passages fall through to null. */
  failedNamespaces: SourceNamespace[];
}

/** Same namespaced-key split as refetch.ts (`verse:<uuid>`). */
function parseKey(key: string): { ns: string; id: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return { ns: key.slice(0, idx), id: key.slice(idx + 1) };
}

/**
 * PostgREST returns an embedded resource as an object for a to-one join and as
 * an array for a to-many one, exactly as refetch.ts normalises it.
 */
function nested(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? null;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** A URL only counts when it is a non-blank string. Anything else is null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** The stored URL for one row of one namespace, or null. Never a guess. */
function urlFromRow(ns: SourceNamespace, row: Record<string, unknown>): string | null {
  if (ns === "purport") return str(nested(row.verses)?.vedabase_url);
  if (ns === "book") return str(row.vedabase_url_precise) ?? str(row.vedabase_url);
  return str(row.vedabase_url);
}

/**
 * Reads the stored Vedabase URL for the given passage keys.
 *
 * One query per namespace, not one per passage — the same shape refetch.ts
 * uses, and only the id and URL columns, so no body text crosses the wire for
 * passages that will never render their words.
 *
 * This function never rejects. A read that fails costs those passages their
 * link and nothing else, so the caller can start it early and await it late
 * without risking an unhandled rejection or a lost search.
 */
export async function fetchSourceUrls(
  db: SupabaseLike,
  passageKeys: string[],
  ctx: { requestId: string },
): Promise<SourceUrlResult> {
  const urls = new Map<string, string>();
  const failedNamespaces: SourceNamespace[] = [];
  let fetchCount = 0;

  const byNamespace = new Map<SourceNamespace, Map<string, string[]>>();
  for (const key of passageKeys) {
    const parsed = parseKey(key);
    // An unknown namespace is simply not linkable. refetch.ts is where an
    // unrecognised key becomes a recorded drop; here it is a missing button.
    if (!parsed || !isSourceNamespace(parsed.ns)) continue;
    const byId = byNamespace.get(parsed.ns) ?? new Map<string, string[]>();
    const keysForId = byId.get(parsed.id) ?? [];
    keysForId.push(key);
    byId.set(parsed.id, keysForId);
    byNamespace.set(parsed.ns, byId);
  }

  for (const [ns, byId] of byNamespace) {
    const ids = [...byId.keys()];
    if (ids.length === 0) continue;

    let rows: Record<string, unknown>[];
    try {
      fetchCount += 1;
      const result = await db.from(URL_TABLES[ns]).select(URL_COLUMNS[ns]).in("id", ids);
      rows = unwrapOrThrow<Record<string, unknown>[]>(result, `source-url:${ns}`, {
        stage: "verify:source-url",
        requestId: ctx.requestId,
      });
    } catch (error) {
      failedNamespaces.push(ns);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "search.source_url_lookup_failed",
          requestId: ctx.requestId,
          namespace: ns,
          passages: ids.length,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      continue;
    }

    for (const row of rows ?? []) {
      const id = str(row.id);
      if (!id) continue;
      const url = urlFromRow(ns, row);
      if (!url) continue;
      for (const key of byId.get(id) ?? []) urls.set(key, url);
    }
  }

  return { urls, fetchCount, failedNamespaces };
}
