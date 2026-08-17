/**
 * chunk-dedupe.test.ts — the two id rules, and who ends up owning each list.
 *
 * Verse chunks overlap on purpose, so two chunks of one verse are the same
 * teaching printed twice and a chunk beside its parent verse is the verse
 * quoted against itself. Neither is catchable by text comparison; both are
 * exact facts about identity. These tests pin them as such, and pin the thing
 * that makes them safe: a failed parent lookup drops NOTHING.
 */
import { describe, expect, it, vi } from "vitest";
import {
  dropRedundantVerseChunks,
  fetchChunkParents,
  type DedupableCandidate,
} from "@/app/lib/search-v2/chunk-dedupe";

function c(
  passage_key: string,
  source_type: string,
  row_id: string,
  pinned = false,
): DedupableCandidate {
  return { passage_key, source_type, row_id, pinned };
}

/** chunk row id → parent verse row id. */
const PARENTS = new Map([
  ["ch1", "v1"],
  ["ch2", "v1"],
  ["ch3", "v2"],
]);

describe("rule 1 — never a chunk beside its own parent verse", () => {
  it("drops the chunk and keeps the verse", () => {
    const ranked = [
      c("verse:v1", "verse", "v1"),
      c("purport:ch1", "purport", "ch1"),
      c("verse:v9", "verse", "v9"),
    ];
    const out = dropRedundantVerseChunks(ranked, PARENTS);

    expect(out.kept.map((x) => x.passage_key)).toEqual(["verse:v1", "verse:v9"]);
    expect(out.dropped).toEqual([
      { passageKey: "purport:ch1", verseId: "v1", reason: "chunk_of_kept_verse" },
    ]);
  });

  it("drops the chunk even when the chunk outranked the verse", () => {
    // Rule 1 is about identity, not relevance: the verse is the whole of what
    // the chunk is part of, so the chunk is the redundant one either way.
    const out = dropRedundantVerseChunks(
      [c("purport:ch1", "purport", "ch1"), c("verse:v1", "verse", "v1")],
      PARENTS,
    );
    expect(out.kept.map((x) => x.passage_key)).toEqual(["verse:v1"]);
  });

  it("lets a PINNED chunk suppress its parent verse instead", () => {
    const out = dropRedundantVerseChunks(
      [c("verse:v1", "verse", "v1"), c("purport:ch1", "purport", "ch1", true)],
      PARENTS,
    );
    expect(out.kept.map((x) => x.passage_key)).toEqual(["purport:ch1"]);
    expect(out.dropped[0].reason).toBe("verse_of_pinned_chunk");
  });

  it("keeps a pinned verse over its chunk", () => {
    const out = dropRedundantVerseChunks(
      [c("purport:ch1", "purport", "ch1"), c("verse:v1", "verse", "v1", true)],
      PARENTS,
    );
    expect(out.kept.map((x) => x.passage_key)).toEqual(["verse:v1"]);
  });
});

describe("rule 2 — at most one chunk per verse, the better-ranked one", () => {
  it("keeps the one Cohere put first and drops the sibling", () => {
    const out = dropRedundantVerseChunks(
      [c("purport:ch2", "purport", "ch2"), c("purport:ch1", "purport", "ch1")],
      PARENTS,
    );
    // ch2 came first in the ranked list, so ch2 is the better-ranked one.
    expect(out.kept.map((x) => x.passage_key)).toEqual(["purport:ch2"]);
    expect(out.dropped).toEqual([
      { passageKey: "purport:ch1", verseId: "v1", reason: "sibling_chunk" },
    ]);
  });

  it("lets a pin beat a better-ranked sibling", () => {
    const out = dropRedundantVerseChunks(
      [c("purport:ch2", "purport", "ch2"), c("purport:ch1", "purport", "ch1", true)],
      PARENTS,
    );
    expect(out.kept.map((x) => x.passage_key)).toEqual(["purport:ch1"]);
  });

  it("leaves chunks of DIFFERENT verses alone", () => {
    const out = dropRedundantVerseChunks(
      [c("purport:ch1", "purport", "ch1"), c("purport:ch3", "purport", "ch3")],
      PARENTS,
    );
    expect(out.kept).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });
});

describe("the rules only ever remove", () => {
  it("preserves the arriving order exactly", () => {
    const ranked = [
      c("lecture:a", "lecture", "a"),
      c("purport:ch1", "purport", "ch1"),
      c("verse:v2", "verse", "v2"),
      c("letter:b", "letter", "b"),
      c("purport:ch3", "purport", "ch3"),
    ];
    const out = dropRedundantVerseChunks(ranked, PARENTS);
    // ch3's parent v2 is present, so ch3 goes; nothing else moves.
    expect(out.kept.map((x) => x.passage_key)).toEqual([
      "lecture:a", "purport:ch1", "verse:v2", "letter:b",
    ]);
  });

  it("leaves a chunk whose parent could not be resolved completely alone", () => {
    const out = dropRedundantVerseChunks(
      [c("verse:v1", "verse", "v1"), c("purport:unknown", "purport", "chX")],
      PARENTS,
    );
    expect(out.kept).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });
});

describe("a failed parent lookup drops nothing", () => {
  it("returns an empty map and says it degraded, rather than guessing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      from: () => ({
        select: () => ({
          in: async () => ({ data: null, error: { message: "boom", code: "42P01" } }),
        }),
      }),
    };
    const lookup = await fetchChunkParents(
      db as never,
      [c("purport:ch1", "purport", "ch1")],
      { requestId: "req_test" },
    );

    expect(lookup.degraded).toBe(true);
    expect(lookup.verseIdByChunk.size).toBe(0);
    // And with an empty map the rules are inert — showing a passage twice is a
    // poor answer, but deleting passages on a failed lookup is a wrong one.
    const out = dropRedundantVerseChunks(
      [c("verse:v1", "verse", "v1"), c("purport:ch1", "purport", "ch1")],
      lookup.verseIdByChunk,
    );
    expect(out.kept).toHaveLength(2);
  });

  it("issues no read at all when the pool holds no chunks", async () => {
    const from = vi.fn();
    const lookup = await fetchChunkParents(
      { from } as never,
      [c("verse:v1", "verse", "v1")],
      { requestId: "req_test" },
    );
    expect(from).not.toHaveBeenCalled();
    expect(lookup.fetchCount).toBe(0);
    expect(lookup.degraded).toBe(false);
  });
});
