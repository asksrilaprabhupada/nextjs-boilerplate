/**
 * chunk-dedupe.ts — the two ID rules that stop a verse being read twice.
 *
 * Verse chunks are cut with DELIBERATE OVERLAP: neighbouring chunks repeat each
 * other's words so a sentence spanning a boundary is still findable. That is
 * right for retrieval and wrong for reading. Two chunks of SB 1.2.6 in the same
 * answer are the same teaching printed twice, and a chunk shown beside its own
 * parent verse is the verse quoted against itself. Five hundred consecutive
 * same-verse pairs were measured and all 500 shared words at the edges.
 *
 * Text comparison cannot catch either case reliably — overlapping chunks share
 * only part of their words, and a chunk is a strict subset of its verse, not a
 * copy. Both are exact facts about IDENTITY, so both are settled by id:
 *
 *   1. A chunk is never kept beside its parent verse. `verse_chunks.verse_id`
 *      is a direct foreign key, so this is a lookup, not a guess.
 *   2. At most one chunk survives per verse: the better-ranked one.
 *
 * THE RULES RUN AFTER COHERE, over its one ranked list, so "better-ranked" is
 * simply "earlier in that list" — no score arithmetic, no second opinion about
 * what better means. Order is preserved: this only removes.
 *
 * A pinned passage — the one a devotee asked for by reference — is never
 * removed by a passage that is not pinned, and it suppresses whichever of its
 * parent or chunk it conflicts with. Losing BG 18.66 from a search for
 * "BG 18.66" is the one outcome that cannot be defended.
 *
 * The chunk namespace is `purport:` (see refetch.ts SOURCE_TABLES), which maps
 * to the verse_chunks table; `verse:` maps to verses.
 */
import { unwrapOrThrow, type RpcCapableClient } from "@/app/lib/search-v2/rpc";

interface SupabaseLike extends RpcCapableClient {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

/** The only fields these rules read. */
export interface DedupableCandidate {
  passage_key: string;
  source_type: string;
  row_id: string;
  pinned?: boolean;
}

export type ChunkDropReason =
  | "chunk_of_kept_verse"
  | "verse_of_pinned_chunk"
  | "sibling_chunk";

export interface ChunkParentLookup {
  /** chunk row id → parent verse row id. Empty when the lookup failed. */
  verseIdByChunk: Map<string, string>;
  /** Table reads issued, so no read this pipeline makes is invisible. */
  fetchCount: number;
  /** True when the lookup failed; the rules then drop nothing at all. */
  degraded: boolean;
}

/**
 * Reads every chunk's parent verse id.
 *
 * Split out from the rules so it can run CONCURRENTLY with the rerank: the
 * chunk ids are known as soon as the pool is, and the rules do not need the
 * answer until Cohere has replied. One indexed `IN` over at most a few hundred
 * ids, off the critical path entirely.
 *
 * Never throws. A failed lookup returns an empty map, and the rules treat an
 * unresolved parent as "leave this passage alone": showing a devotee one
 * passage twice is a poor answer, but dropping passages on the strength of a
 * failed lookup is a wrong one.
 */
export async function fetchChunkParents(
  db: SupabaseLike,
  candidates: readonly DedupableCandidate[],
  ctx: { requestId: string },
): Promise<ChunkParentLookup> {
  const chunkIds = [...new Set(
    candidates.filter((c) => c.source_type === "purport").map((c) => c.row_id),
  )];
  if (chunkIds.length === 0) {
    return { verseIdByChunk: new Map(), fetchCount: 0, degraded: false };
  }

  let rows: Record<string, unknown>[];
  try {
    const result = await db.from("verse_chunks").select("id, verse_id").in("id", chunkIds);
    rows = unwrapOrThrow<Record<string, unknown>[]>(result, "chunk-dedupe", {
      stage: "reranking:chunk-parents",
      requestId: ctx.requestId,
    });
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "search.chunk_parent_lookup_failed",
      requestId: ctx.requestId,
      chunks: chunkIds.length,
      message: error instanceof Error ? error.message : String(error),
    }));
    return { verseIdByChunk: new Map(), fetchCount: 1, degraded: true };
  }

  const verseIdByChunk = new Map<string, string>();
  for (const row of rows ?? []) {
    const id = typeof row.id === "string" ? row.id : null;
    const verseId = typeof row.verse_id === "string" ? row.verse_id : null;
    if (id && verseId) verseIdByChunk.set(id, verseId);
  }
  return { verseIdByChunk, fetchCount: 1, degraded: false };
}

export interface ChunkDedupeResult<T> {
  /** The survivors, in exactly the order they arrived. */
  kept: T[];
  dropped: Array<{ passageKey: string; verseId: string; reason: ChunkDropReason }>;
}

/**
 * Applies both rules to one ALREADY-RANKED list. Pure; order-preserving.
 *
 * A single forward pass is enough because the list is sorted best-first: the
 * first chunk seen for a verse is by definition the better-ranked one, and any
 * later sibling loses to it.
 */
export function dropRedundantVerseChunks<T extends DedupableCandidate>(
  ranked: readonly T[],
  verseIdByChunk: ReadonlyMap<string, string>,
): ChunkDedupeResult<T> {
  const dropped: ChunkDedupeResult<T>["dropped"] = [];
  const removed = new Set<string>();

  const verseByRowId = new Map<string, T>();
  for (const c of ranked) if (c.source_type === "verse") verseByRowId.set(c.row_id, c);

  const chunkKeptForVerse = new Map<string, T>();

  for (const c of ranked) {
    if (c.source_type !== "purport") continue;
    const verseId = verseIdByChunk.get(c.row_id);
    // A chunk whose parent could not be resolved is left alone. Neither rule
    // can be applied to it honestly.
    if (!verseId) continue;

    // ── Rule 1: never a chunk beside its own parent verse ──
    const parent = verseByRowId.get(verseId);
    if (parent && !removed.has(parent.passage_key)) {
      if (c.pinned && !parent.pinned) {
        // A pin suppresses whichever of the pair it conflicts with.
        dropped.push({
          passageKey: parent.passage_key,
          verseId,
          reason: "verse_of_pinned_chunk",
        });
        removed.add(parent.passage_key);
      } else {
        dropped.push({ passageKey: c.passage_key, verseId, reason: "chunk_of_kept_verse" });
        removed.add(c.passage_key);
        continue;
      }
    }

    // ── Rule 2: at most one chunk per verse, the better-ranked one ──
    const sitting = chunkKeptForVerse.get(verseId);
    if (!sitting) {
      chunkKeptForVerse.set(verseId, c);
      continue;
    }
    // `sitting` came first, so it is better ranked — unless this one is pinned
    // and it is not, which no ranking may override.
    const loser = c.pinned && !sitting.pinned ? sitting : c;
    if (loser === sitting) chunkKeptForVerse.set(verseId, c);
    dropped.push({ passageKey: loser.passage_key, verseId, reason: "sibling_chunk" });
    removed.add(loser.passage_key);
  }

  return { kept: ranked.filter((c) => !removed.has(c.passage_key)), dropped };
}
