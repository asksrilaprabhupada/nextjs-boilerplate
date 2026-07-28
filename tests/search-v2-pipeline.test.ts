/**
 * search-v2-pipeline.test.ts — Unit cover for the Phase B decision layer.
 *
 * These cover the parts that decide WHAT a devotee is shown: fusion weighting,
 * duplicate collapse and evidence selection. All are pure, so they run without a
 * database, a provider key or a network.
 *
 * The assertions are written around the failures the brief calls unrecoverable
 * — a letter losing its recipient, a variant outvoting the original question, a
 * verse collapsed into its purport — rather than around happy paths.
 */
import { describe, it, expect } from "vitest";
import { extractReference, normalizeReference } from "@/app/lib/search-v2/reference";
import { fuseWeighted, buildPriorityMap, type RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import { dedupeCandidates, mustNotCollapse, normalizeForHash } from "@/app/lib/search-v2/dedup";
import { selectEvidence, isLabellable } from "@/app/lib/search-v2/select";
import { semanticRejections, QueryPlanSchema, fallbackPlan } from "@/app/lib/search-v2/query-plan";
import { SEARCH_V2_CONFIG } from "@/app/lib/search-v2/config";

// ─── helpers ─────────────────────────────────────────────────

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
    matched_query_ids: [],
    channel_ranks: [],
    channel_scores: {},
    tag_matches: 0,
    ...over,
  } as RetrievedCandidate;
}

// ─── scripture references: a retrieval clue, never a road ────

describe("reference extraction", () => {
  it("normalises a reference for the lookup RPC", () => {
    expect(extractReference("bg 18.66")).toBe("BG 18.66");
    expect(extractReference("  SB 1.2.6 ")).toBe("SB 1.2.6");
    expect(extractReference("what does BG 18.66 mean?")).toBe("BG 18.66");
    expect(normalizeReference("cc  adi 1.1")).toBe("CC adi 1.1");
  });

  it("does not mistake ordinary prose for a reference", () => {
    for (const q of ["what is bhakti", "who was Arjuna", "how do I chant", ""]) {
      expect(extractReference(q), q).toBeNull();
    }
  });
});

// ─── B6: one weighted RRF pass ───────────────────────────────

describe("weighted RRF fusion", () => {
  it("lets the original question outrank an agreeing bloc of weak variants", () => {
    const priorities = buildPriorityMap("q_orig", [
      { id: "s1", priority: "exploratory" },
      { id: "s2", priority: "exploratory" },
      { id: "s3", priority: "exploratory" },
    ]);

    // "right" is rank 1 for the original question only.
    const right = candidate({
      passage_key: "verse:right",
      channel_ranks: [{ query_id: "q_orig", channel: "fts_core", rank: 1 }],
    });
    // "wrong" is rank 1 for all three exploratory variants and absent from the
    // original's results — the exact case a second equal-weight RRF gets wrong.
    const wrong = candidate({
      passage_key: "verse:wrong",
      channel_ranks: [
        { query_id: "s1", channel: "semantic", rank: 1 },
        { query_id: "s2", channel: "semantic", rank: 1 },
        { query_id: "s3", channel: "semantic", rank: 1 },
      ],
    });

    const fused = fuseWeighted([[wrong, right]], priorities);
    expect(fused[0].passage_key).toBe("verse:right");
  });

  it("scores exactly w_query x w_channel / (k + rank)", () => {
    const fused = fuseWeighted(
      [[candidate({ passage_key: "verse:a", channel_ranks: [{ query_id: "q", channel: "semantic", rank: 4 }] })]],
      { q: "original" },
    );
    const expected =
      (SEARCH_V2_CONFIG.queryWeights.original * SEARCH_V2_CONFIG.channelWeights.semantic) /
      (SEARCH_V2_CONFIG.rrfK + 4);
    expect(fused[0].fusedScore).toBeCloseTo(expected, 12);
  });

  it("never lets an unknown query id inherit the original's weight", () => {
    const fused = fuseWeighted(
      [[candidate({ passage_key: "verse:a", channel_ranks: [{ query_id: "spoofed", channel: "semantic", rank: 1 }] })]],
      { q_orig: "original" },
    );
    expect(fused[0].contributions[0].queryWeight).toBe(SEARCH_V2_CONFIG.queryWeights.supporting);
  });

  it("ignores channels it does not know rather than guessing a weight", () => {
    const fused = fuseWeighted(
      [[candidate({ passage_key: "verse:a", channel_ranks: [{ query_id: "q", channel: "telepathy", rank: 1 }] })]],
      { q: "original" },
    );
    expect(fused[0].fusedScore).toBe(0);
    expect(fused[0].contributions).toHaveLength(0);
  });

  it("fuses the same passage across tables into one entry", () => {
    const a = candidate({ passage_key: "verse:x", channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 2 }] });
    const b = candidate({ passage_key: "verse:x", channel_ranks: [{ query_id: "q", channel: "semantic", rank: 3 }] });
    const fused = fuseWeighted([[a], [b]], { q: "original" });
    expect(fused).toHaveLength(1);
    expect(fused[0].contributions).toHaveLength(2);
  });

  it("retains an auditable per-contribution breakdown", () => {
    const fused = fuseWeighted(
      [[candidate({ passage_key: "verse:a", channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }] })]],
      { q: "original" },
    );
    expect(fused[0].contributions[0]).toMatchObject({ queryId: "q", channel: "fts_core", rank: 1 });
  });
});

// ─── B7: deduplication ───────────────────────────────────────

describe("deduplication", () => {
  const fuse = (c: RetrievedCandidate[]) => fuseWeighted([c], { q: "original" });

  it("never collapses a verse into its purport", () => {
    const [v, p] = fuse([
      candidate({ passage_key: "verse:1", source_type: "verse", retrieval_text: "same words here" }),
      candidate({ passage_key: "purport:1", source_type: "purport", retrieval_text: "same words here" }),
    ]);
    expect(mustNotCollapse(v, p)).toBe(true);
    expect(dedupeCandidates([v, p]).candidates).toHaveLength(2);
  });

  it("never collapses a personal letter into a book instruction", () => {
    const [l, b] = fuse([
      candidate({ passage_key: "letter:1", source_type: "letter", retrieval_text: "identical text" }),
      candidate({ passage_key: "book:1", source_type: "book", retrieval_text: "identical text" }),
    ]);
    expect(mustNotCollapse(l, b)).toBe(true);
  });

  it("never collapses letters to different recipients", () => {
    const [a, b] = fuse([
      candidate({ passage_key: "letter:1", source_type: "letter", recipient: "Rayarama", retrieval_text: "t" }),
      candidate({ passage_key: "letter:2", source_type: "letter", recipient: "Brahmananda", retrieval_text: "t" }),
    ]);
    expect(mustNotCollapse(a, b)).toBe(true);
  });

  it("collapses genuine duplicates and keeps the alternate for disclosure", () => {
    const fused = fuse([
      candidate({ passage_key: "book:1", source_type: "book", retrieval_text: "The soul is eternal.", reference: "A 1" }),
      candidate({ passage_key: "book:2", source_type: "book", retrieval_text: "the  soul is eternal!", reference: "B 2" }),
    ]);
    const out = dedupeCandidates(fused);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].alternates).toHaveLength(1);
    expect(out.stats.exactCollapsed).toBe(1);
  });

  it("prefers the copy carrying a reference when collapsing", () => {
    const fused = fuse([
      candidate({ passage_key: "book:1", source_type: "book", retrieval_text: "same", reference: null }),
      candidate({ passage_key: "book:2", source_type: "book", retrieval_text: "same", reference: "SB 1.1.1" }),
    ]);
    expect(dedupeCandidates(fused).candidates[0].reference).toBe("SB 1.1.1");
  });

  it("skips near-duplicate collapse entirely when embeddings are absent", () => {
    const fused = fuse([
      candidate({ passage_key: "book:1", source_type: "book", retrieval_text: "alpha" }),
      candidate({ passage_key: "book:2", source_type: "book", retrieval_text: "beta" }),
    ]);
    expect(dedupeCandidates(fused, undefined).stats.nearCollapsed).toBe(0);
  });

  it("collapses near-duplicates above the cosine threshold", () => {
    const fused = fuse([
      candidate({ passage_key: "book:1", source_type: "book", retrieval_text: "alpha" }),
      candidate({ passage_key: "book:2", source_type: "book", retrieval_text: "beta" }),
    ]);
    const emb = new Map([
      ["book:1", [1, 0, 0]],
      ["book:2", [0.999, 0.03, 0]],
    ]);
    const out = dedupeCandidates(fused, emb, 0.95);
    expect(out.candidates).toHaveLength(1);
    expect(out.stats.nearCollapsed).toBe(1);
  });

  it("normalises punctuation and diacritics for hashing only", () => {
    expect(normalizeForHash("Kṛṣṇa’s  mercy!")).toBe(normalizeForHash("krsna's mercy"));
  });
});

// ─── B9: evidence selection ──────────────────────────────────

describe("evidence selection", () => {
  const build = (cs: RetrievedCandidate[]) => dedupeCandidates(fuseWeighted([cs], { q: "original" })).candidates;

  it("excludes a letter that cannot be labelled with recipient and date", () => {
    const unlabelled = build([
      candidate({ passage_key: "letter:1", source_type: "letter", recipient: null, occurred_on: null }),
    ])[0];
    expect(isLabellable(unlabelled)).toBe(false);

    const labelled = build([
      candidate({ passage_key: "letter:2", source_type: "letter", recipient: "Rayarama", occurred_on: "1968-01-02" }),
    ])[0];
    expect(isLabellable(labelled)).toBe(true);
  });

  it("attaches a context requirement to letters and recorded conversations", () => {
    const ranked = build([
      candidate({
        passage_key: "letter:1",
        source_type: "letter",
        recipient: "Rayarama",
        occurred_on: "1968-01-02",
        channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }],
      }),
    ]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], maxFinalPassages: 4 });
    expect(out.selected[0].contextRequirements).toContain("letter_context");
  });

  it("does not force a letter or a lecture in for variety", () => {
    const ranked = build([
      candidate({ passage_key: "verse:1", retrieval_text: "the first distinct verse", channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }], matched_query_ids: ["q"] }),
      candidate({ passage_key: "verse:2", retrieval_text: "the second distinct verse", channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 2 }], matched_query_ids: ["q"] }),
      candidate({ passage_key: "letter:9", retrieval_text: "a far weaker letter paragraph", source_type: "letter", recipient: "X", occurred_on: "1970-01-01", channel_ranks: [{ query_id: "q", channel: "semantic", rank: 400 }], matched_query_ids: ["q"] }),
    ]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], maxFinalPassages: 8 });
    expect(out.selected.every((s) => s.candidate.source_type !== "letter")).toBe(true);
  });

  it("never exceeds the passage ceiling, however many candidates survive", () => {
    const ranked = build(
      Array.from({ length: 40 }, (_, i) =>
        candidate({
          passage_key: `verse:${i}`,
          retrieval_text: `distinct text ${i}`,
          channel_ranks: [{ query_id: "q", channel: "fts_core", rank: i + 1 }],
          matched_query_ids: ["q"],
        }),
      ),
    );
    // One sizing band for every question. The ceiling is the ceiling; it is not
    // relaxed or tightened by guessing what kind of question was asked.
    expect(selectEvidence({ ranked, approvedQueryIds: ["q"], maxFinalPassages: 8 }).selected.length)
      .toBeLessThanOrEqual(8);
    expect(selectEvidence({ ranked, approvedQueryIds: ["q"], maxFinalPassages: 3 }).selected.length)
      .toBeLessThanOrEqual(3);
  });

  it("pulls in the purport partner of the primary verse", () => {
    const ranked = build([
      candidate({ passage_key: "verse:1", source_type: "verse", reference: "BG 6.6", retrieval_text: "v", channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }] }),
      candidate({ passage_key: "purport:1", source_type: "purport", reference: "BG 6.6", retrieval_text: "p", channel_ranks: [{ query_id: "q", channel: "semantic", rank: 30 }] }),
    ]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], maxFinalPassages: 8 });
    expect(out.selected.map((s) => s.candidate.passage_key)).toContain("purport:1");
  });

  it("reports uncovered subqueries instead of pretending to answer them", () => {
    const ranked = build([
      candidate({ passage_key: "verse:1", matched_query_ids: ["q"], channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }] }),
    ]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q", "s1"], maxFinalPassages: 8 });
    expect(out.uncoveredQueryIds).toContain("s1");
  });

  it("reports evidence_insufficient when nothing is selectable", () => {
    const ranked = build([
      candidate({ passage_key: "letter:1", source_type: "letter", recipient: null, occurred_on: null }),
    ]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], maxFinalPassages: 8 });
    expect(out.evidenceInsufficient).toBe(true);
  });
});

// ─── B2: query-plan semantic validation ──────────────────────

describe("query plan validation", () => {
  /** The one fan-out ceiling. Every question is planned against it. */
  const MAX_SUBQUERIES = 6;
  const base = fallbackPlan("how do I control my mind");
  const check = (query: string, plan: typeof base) =>
    semanticRejections({ query, plan, maxSubqueries: MAX_SUBQUERIES });

  it("accepts the fallback plan against its own schema", () => {
    expect(QueryPlanSchema.safeParse(base).success).toBe(true);
  });

  it("carries a reference the devotee wrote into the fallback plan's constraints", () => {
    // A clue for retrieval, not a decision about how the question is handled.
    expect(fallbackPlan("what does BG 18.66 mean?").constraints.scripture_references)
      .toEqual(["BG 18.66"]);
    expect(base.constraints.scripture_references).toEqual([]);
  });

  it("rejects more subqueries than the budget permits", () => {
    const plan = {
      ...base,
      subqueries: Array.from({ length: MAX_SUBQUERIES + 1 }, (_, i) => ({
        id: `s${i}`,
        text: `distinct angle number ${i} about steadiness`,
        role: "cause" as const,
        priority: "supporting" as const,
      })),
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/budget permits/);
  });

  it("accepts a plan that spends the budget exactly", () => {
    const plan = {
      ...base,
      subqueries: Array.from({ length: MAX_SUBQUERIES }, (_, i) => ({
        id: `s${i}`,
        text: `distinct angle number ${i} about steadiness`,
        role: "cause" as const,
        priority: "supporting" as const,
      })),
    };
    expect(check("how do I control my mind", plan).join(" ")).not.toMatch(/budget permits/);
  });

  it("rejects a subquery equivalent to the original question", () => {
    const plan = {
      ...base,
      subqueries: [{ id: "s1", text: "how do I control my mind", role: "reformulation" as const, priority: "primary" as const }],
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/equivalent/);
  });

  it("rejects near-identical subqueries", () => {
    const plan = {
      ...base,
      subqueries: [
        { id: "s1", text: "steadying the restless mind by practice", role: "method" as const, priority: "primary" as const },
        { id: "s2", text: "steadying the restless mind through practice", role: "practice" as const, priority: "supporting" as const },
      ],
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/near-identical/);
  });

  it("rejects an invented constraint the devotee never asked for", () => {
    const plan = { ...base, constraints: { ...base.constraints, recipient: "Brahmananda" } };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/invented recipient/);
  });

  it("rejects a plan that drops a proper name from the question", () => {
    const q = "what did Prabhupada say about Haridasa Thakura";
    const plan = { ...fallbackPlan(q), canonical_query: "what did he say about the chanting saint" };
    expect(check(q, plan).join(" ")).toMatch(/dropped/);
  });

  it("rejects reserved subquery ids that would inherit the original's weight", () => {
    const plan = {
      ...base,
      subqueries: [{ id: "__tags__", text: "steadying the mind by detachment", role: "method" as const, priority: "primary" as const }],
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/reserved/);
  });

  it("accepts a well-formed plan with genuinely distinct angles", () => {
    const plan = {
      ...base,
      subqueries: [
        { id: "s1", text: "the mind as friend and enemy of the soul", role: "scriptural_basis" as const, priority: "primary" as const },
        { id: "s2", text: "why the mind is restless and flickering", role: "cause" as const, priority: "supporting" as const },
      ],
    };
    expect(check("how do I control my mind", plan)).toEqual([]);
  });
});
