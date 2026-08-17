/**
 * no-limits.test.ts — The three guarantees of the completeness contract.
 *
 *   1. WORDS, NOT NAMES — every main-tier passage in the wire response carries
 *      its actual text. (The end-to-end version of this lives in
 *      search-v2-integration.test.ts; here the adapter is pinned directly.)
 *   2. NOTHING LOST — 500 surviving candidates all come out of selection:
 *      a readable main tier in full, every other one in `additional`. The cut
 *      moves passages between tiers; it never deletes them.
 *   3. REAL DUPLICATES ONLY — two different paragraphs of one purport both
 *      survive; two copies of the same paragraph collapse to one.
 */
import { describe, it, expect } from "vitest";
import { fuseWeighted, type RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import { dedupeCandidates } from "@/app/lib/search-v2/dedup";
import { selectEvidence, MAIN_TIER_MAX } from "@/app/lib/search-v2/select";
import { toWirePassage } from "@/app/lib/search-v2/adapt";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";

function candidate(over: Partial<RetrievedCandidate> & { passage_key: string }): RetrievedCandidate {
  return {
    source_type: "verse",
    row_id: over.passage_key.split(":")[1] ?? "row",
    retrieval_text: "text",
    reference: "BG 1.1",
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["q"],
    channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }],
    channel_scores: {},
    tag_matches: 0,
    ...over,
  } as RetrievedCandidate;
}

describe("1. words, not names", () => {
  it("puts the actual text on the wire passage — a text-free passage is a failure", () => {
    const verified = {
      passageKey: "verse:v1",
      sourceType: "verse",
      rowId: "v1",
      text: "The mind is restless, turbulent, obstinate and very strong, O Kṛṣṇa.",
      reference: "BG 6.34",
      speaker: null, recipient: null, date: null, location: null,
      vedabaseUrl: "https://vedabase.io/en/library/bg/6/34/",
      sanskrit: null, transliteration: null, synonyms: null,
      purport: "One can conquer the mind by suitable practice.",
      scripture: "BG", division: null, chapterNumber: 6,
      selection: { candidate: { alternates: [], rerankScore: 0.87 } },
    } as unknown as VerifiedPassage;

    const wire = toWirePassage(verified);
    expect(wire.text).toBe(verified.text);
    expect(wire.text.trim().length).toBeGreaterThan(0);
    expect(wire.purport).toBe(verified.purport);
    expect(wire.rerankScore).toBe(0.87);
    expect(wire.url).toBe(verified.vedabaseUrl);
    expect(wire.label).toContain("Bhagavad-gītā 6.34");
  });
});

describe("2. nothing lost", () => {
  it("returns all 500 of 500 surviving candidates across the two tiers", () => {
    const ranked = Array.from({ length: 500 }, (_, i) => ({
      ...fuseWeighted(
        [[candidate({ passage_key: `verse:${i}`, retrieval_text: `distinct passage text number ${i}` })]],
        { q: "original" },
      )[0],
      alternates: [],
      rerankScore: 0.8,
    }));

    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    // A reader gets a readable main tier…
    expect(out.selected).toHaveLength(MAIN_TIER_MAX);
    // …and NOTHING is deleted: every other candidate is in the second tier.
    expect(out.selected.length + out.additional.length).toBe(500);
  });
});

describe("3. real duplicates only", () => {
  const PARA_A =
    "The mind is restless, turbulent, obstinate and very strong, and to subdue it is more difficult than controlling the wind, as Arjuna plainly says in this verse to Krsna at the very start of his question about steadiness in yoga practice.";
  const PARA_B =
    "By constant practice and by detachment one can bring the mind under control, and one who has conquered the mind has already reached the Supersoul, being undisturbed in heat and cold, in happiness and in distress, in honor and in dishonor.";

  const fuse = (cs: RetrievedCandidate[]) => fuseWeighted([cs], { q: "original" });

  it("keeps two DIFFERENT paragraphs of the same purport", () => {
    const out = dedupeCandidates(
      fuse([
        candidate({ passage_key: "purport:a", source_type: "purport", reference: "BG 6.34", retrieval_text: PARA_A }),
        candidate({ passage_key: "purport:b", source_type: "purport", reference: "BG 6.34", retrieval_text: PARA_B }),
      ]),
    );
    expect(out.candidates).toHaveLength(2);
    expect(out.stats.exactCollapsed).toBe(0);
    expect(out.stats.containedCollapsed).toBe(0);
  });

  it("collapses two COPIES of the same paragraph to one, remembering the twin", () => {
    const out = dedupeCandidates(
      fuse([
        candidate({ passage_key: "purport:a", source_type: "purport", reference: "BG 6.34", retrieval_text: PARA_A }),
        candidate({ passage_key: "purport:a2", source_type: "purport", reference: "BG 6.34", retrieval_text: `  ${PARA_A.toUpperCase()} ` }),
      ]),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].alternates).toHaveLength(1);
    expect(out.stats.exactCollapsed).toBe(1);
  });
});
