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
import { extractReference, extractSiglum, normalizeReference } from "@/app/lib/search-v2/reference";
import {
  fuseWeighted,
  buildPriorityMap,
  applyJunkFloor,
  type RetrievedCandidate,
} from "@/app/lib/search-v2/fusion";
import { dedupeCandidates, mustNotCollapse, normalizeForHash } from "@/app/lib/search-v2/dedup";
import {
  selectEvidence,
  isLabellable,
  findCut,
  MAIN_TIER_MIN,
  MAIN_TIER_MAX,
} from "@/app/lib/search-v2/select";
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

  it("extracts the SIGLUM alone for the scripture filter", () => {
    // The `scripture` column stores "BG", never "BG 18.66": the full reference
    // as a filter matches zero rows and silently deletes every verse.
    expect(extractSiglum("BG 18.66")).toBe("BG");
    expect(extractSiglum("what does sb 1.2.6 mean?")).toBe("SB");
    expect(extractSiglum("what is bhakti")).toBeNull();
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

  const LONG_PURPORT = "The mind is restless turbulent obstinate and very strong O Krsna and to subdue it I think is more difficult than controlling the wind. But it is possible by constant practice and by detachment, as the yoga system prescribes, and one who has conquered the mind has already reached the Supersoul, because he has attained tranquillity in heat and cold, happiness and distress, honor and dishonor alike.";

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

  it("never merges two passages merely because they sound alike", () => {
    // Two DIFFERENT paragraphs of one purport answer two different parts of a
    // question. Similar wording is not the same passage.
    const fused = fuse([
      candidate({ passage_key: "purport:1", source_type: "purport", reference: "BG 6.34", retrieval_text: "The mind is restless and turbulent, and controlling it by practice is recommended in this verse for every serious student of yoga who wishes to advance steadily." }),
      candidate({ passage_key: "purport:2", source_type: "purport", reference: "BG 6.34", retrieval_text: "The mind is turbulent and restless, and detachment from sense objects is the second recommendation, without which practice alone cannot steady anyone at any stage." }),
    ]);
    const out = dedupeCandidates(fused);
    expect(out.candidates).toHaveLength(2);
    expect(out.stats.containedCollapsed).toBe(0);
  });

  it("absorbs a chunk that sits almost entirely inside a longer chunk of the same purport", () => {
    const long = LONG_PURPORT;
    const short = LONG_PURPORT.slice(0, Math.floor(LONG_PURPORT.length * 0.7));
    const fused = fuse([
      candidate({ passage_key: "purport:short", source_type: "purport", reference: "BG 6.34", retrieval_text: short }),
      candidate({ passage_key: "purport:long", source_type: "purport", reference: "BG 6.34", retrieval_text: long }),
    ]);
    const out = dedupeCandidates(fused);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].passage_key).toBe("purport:long"); // the longer wins
    expect(out.stats.containedCollapsed).toBe(1);
  });

  it("never applies containment across references or source types", () => {
    const fused = fuse([
      candidate({ passage_key: "purport:a", source_type: "purport", reference: "BG 6.34", retrieval_text: LONG_PURPORT }),
      // The same words under a DIFFERENT reference bucket is not absorbed…
      candidate({ passage_key: "lecture:b", source_type: "lecture", reference: "Lecture 1969", retrieval_text: LONG_PURPORT.slice(0, 200) }),
    ]);
    // …because a lecture quoting a purport is a different act of teaching.
    expect(dedupeCandidates(fused).stats.containedCollapsed).toBe(0);
  });

  it("normalises punctuation and diacritics for hashing only", () => {
    expect(normalizeForHash("Kṛṣṇa’s  mercy!")).toBe(normalizeForHash("krsna's mercy"));
  });
});

// ─── B9: evidence selection — by relevance, not by counting ──

describe("evidence selection", () => {
  const build = (cs: RetrievedCandidate[]) => dedupeCandidates(fuseWeighted([cs], { q: "original" })).candidates;
  const scored = (cs: RetrievedCandidate[], scores: (number | null)[]) =>
    build(cs).map((c, i) => ({ ...c, rerankScore: scores[i] ?? null }));

  const verses = (n: number, at = (i: number) => `distinct verse text number ${i}`) =>
    Array.from({ length: n }, (_, i) =>
      candidate({
        passage_key: `verse:${i}`,
        retrieval_text: at(i),
        channel_ranks: [{ query_id: "q", channel: "fts_core", rank: i + 1 }],
        matched_query_ids: ["q"],
      }),
    );

  it("excludes a letter that cannot be labelled with recipient and date", () => {
    const unlabelled = scored(
      [candidate({ passage_key: "letter:1", source_type: "letter", recipient: null, occurred_on: null })],
      [0.9],
    )[0];
    expect(isLabellable(unlabelled)).toBe(false);

    const labelled = scored(
      [candidate({ passage_key: "letter:2", source_type: "letter", recipient: "Rayarama", occurred_on: "1968-01-02" })],
      [0.9],
    )[0];
    expect(isLabellable(labelled)).toBe(true);

    const out = selectEvidence({
      ranked: [unlabelled, labelled],
      approvedQueryIds: ["q"],
      rerankAvailable: true,
    });
    expect(out.selected.map((x) => x.candidate.passage_key)).not.toContain("letter:1");
  });

  it("attaches a context requirement to letters and recorded conversations", () => {
    const ranked = scored(
      [candidate({
        passage_key: "letter:1",
        source_type: "letter",
        recipient: "Rayarama",
        occurred_on: "1968-01-02",
        channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }],
      })],
      [0.9],
    );
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    expect(out.selected[0].contextRequirements).toContain("letter_context");
  });

  it("cuts at the largest score gap inside the window — passages move tiers, never vanish", () => {
    // Fifteen strong scores, then a cliff. The cut lands ON the cliff.
    const scores = Array.from({ length: 40 }, (_, i) => (i < 15 ? 0.8 : 0.05));
    const out = selectEvidence({
      ranked: scored(verses(40), scores),
      approvedQueryIds: ["q"],
      rerankAvailable: true,
    });
    expect(out.selected).toHaveLength(15);
    expect(out.cutIndex).toBe(15);
    expect(out.additional).toHaveLength(25);
  });

  it("falls back to the cap when the curve is flat — no natural boundary exists", () => {
    const ranked = scored(verses(60), Array.from({ length: 60 }, () => 0.55));
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    expect(out.selected).toHaveLength(MAIN_TIER_MAX);
    expect(out.selected.length + out.additional.length).toBe(60);
  });

  it("never cuts below the window floor, even when the real falloff is earlier", () => {
    // The falloff at 3 sits below MAIN_TIER_MIN, so the window sees a flat
    // curve and the cap governs. The weak tail is still visible as citations.
    const scores = Array.from({ length: 40 }, (_, i) => (i < 3 ? 0.8 : 0.05));
    const out = selectEvidence({
      ranked: scored(verses(40), scores),
      approvedQueryIds: ["q"],
      rerankAvailable: true,
    });
    expect(out.selected.length).toBeGreaterThanOrEqual(MAIN_TIER_MIN);
    expect(out.selected.length + out.additional.length).toBe(40);
  });

  it("takes the cap off the fused order when the reranker was unreachable", () => {
    const ranked = scored(verses(150), Array.from({ length: 150 }, () => null));
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: false });
    expect(out.selected).toHaveLength(MAIN_TIER_MAX);
    expect(out.additional).toHaveLength(150 - MAIN_TIER_MAX);
  });

  it("prepends a pinned exact-reference passage without consuming a slot", () => {
    const pool = verses(30);
    const pinnedPool = [
      { ...pool[29], passage_key: "verse:pinned", pinned: true },
      ...pool.slice(0, 29),
    ];
    // The pinned verse scored WORST — irrelevant: the devotee asked for it.
    const ranked = scored(pinnedPool, [0.01, ...Array.from({ length: 29 }, () => 0.7)]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    expect(out.selected[0].candidate.passage_key).toBe("verse:pinned");
    expect(out.selected[0].reasons[0]).toBe("exact reference requested");
    // The flat 0.7 curve caps at MAIN_TIER_MAX; the pin rides on top of it.
    expect(out.selected).toHaveLength(MAIN_TIER_MAX + 1);
  });

  it("preserves the reranker's order — never re-sorts", () => {
    const ranked = scored(verses(20), Array.from({ length: 20 }, (_, i) => 0.9 - i * 0.01));
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    expect(out.selected.map((x) => x.candidate.passage_key)).toEqual(ranked.map((c) => c.passage_key));
  });

  it("pulls in the purport partner of the primary verse even below the line", () => {
    // Twelve passages clear the threshold (so the floor is not in play); the
    // primary verse's own purport scored far below the line on its own.
    const pool = [
      candidate({ passage_key: "verse:primary", source_type: "verse", reference: "BG 6.6", retrieval_text: "the primary verse", channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }] }),
      ...verses(11, (i) => `supporting verse number ${i}`).map((c, i) => ({ ...c, passage_key: `verse:s${i}`, reference: `BG 9.${i + 1}` })),
      candidate({ passage_key: "purport:primary", source_type: "purport", reference: "BG 6.6", retrieval_text: "its purport", channel_ranks: [{ query_id: "q", channel: "semantic", rank: 30 }] }),
    ];
    const ranked = scored(pool, [0.9, ...Array.from({ length: 11 }, () => 0.6), 0.02]);
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    const keys = out.selected.map((x) => x.candidate.passage_key);
    expect(keys).toContain("purport:primary");
    // Inserted directly after its verse, not appended or re-sorted elsewhere.
    expect(keys.indexOf("purport:primary")).toBe(keys.indexOf("verse:primary") + 1);
  });

  it("reports uncovered subqueries instead of pretending to answer them", () => {
    const ranked = scored(
      [candidate({ passage_key: "verse:1", matched_query_ids: ["q"], channel_ranks: [{ query_id: "q", channel: "fts_core", rank: 1 }] })],
      [0.9],
    );
    const out = selectEvidence({ ranked, approvedQueryIds: ["q", "s1"], rerankAvailable: true });
    expect(out.uncoveredQueryIds).toContain("s1");
  });

  it("reports evidence_insufficient when nothing is selectable", () => {
    const ranked = scored(
      [candidate({ passage_key: "letter:1", source_type: "letter", recipient: null, occurred_on: null })],
      [0.9],
    );
    const out = selectEvidence({ ranked, approvedQueryIds: ["q"], rerankAvailable: true });
    expect(out.evidenceInsufficient).toBe(true);
  });
});

// ─── the tier cut, in isolation ──────────────────────────────

describe("findCut", () => {
  it("cuts after the largest drop inside the window", () => {
    const scores = [0.9, 0.88, 0.87, 0.86, 0.85, 0.84, 0.83, 0.82, 0.81, 0.8, 0.4, 0.39];
    // The 0.8 → 0.4 cliff sits at index 10, inside [MAIN_TIER_MIN, MAIN_TIER_MAX].
    expect(findCut(scores)).toEqual({ cutIndex: 10, cutGap: expect.closeTo(0.4, 5) });
  });

  it("caps a flat curve at MAIN_TIER_MAX — noise is not a boundary", () => {
    const flat = Array.from({ length: 60 }, () => 0.5);
    expect(findCut(flat).cutIndex).toBe(MAIN_TIER_MAX);
  });

  it("keeps everything when fewer than the window floor survive", () => {
    expect(findCut([0.9, 0.2, 0.1]).cutIndex).toBe(3);
  });

  it("caps when there are no scores to split on (reranker down)", () => {
    const nulls = Array.from({ length: 50 }, () => null);
    expect(findCut(nulls).cutIndex).toBe(MAIN_TIER_MAX);
  });
});

// ─── the junk floor ──────────────────────────────────────────

describe("junk floor", () => {
  const LONG = "A passage long enough to be an actual passage rather than a section header or a one-word reply.";

  it("drops sub-floor fragments and counts them", () => {
    const groups = [[
      candidate({ passage_key: "lecture:1", source_type: "lecture", retrieval_text: "Devotee: No." }),
      candidate({ passage_key: "lecture:2", source_type: "lecture", retrieval_text: LONG }),
    ]];
    const out = applyJunkFloor(groups);
    expect(out.dropped).toBe(1);
    expect(out.groups[0].map((c) => c.passage_key)).toEqual(["lecture:2"]);
  });

  it("exempts verses — some translations are legitimately short", () => {
    const groups = [[candidate({ passage_key: "verse:1", source_type: "verse", retrieval_text: "Tat tvam asi." })]];
    expect(applyJunkFloor(groups).dropped).toBe(0);
  });

  it("exempts a pinned passage — the devotee asked for it by name", () => {
    const groups = [[
      candidate({ passage_key: "lecture:p", source_type: "lecture", retrieval_text: "Short.", pinned: true }),
    ]];
    expect(applyJunkFloor(groups).dropped).toBe(0);
  });
});

// ─── B2: query-plan semantic validation ──────────────────────

describe("query plan validation", () => {
  /** The one fan-out size. Every question is planned to hit it exactly. */
  const MAX_SUBQUERIES = 5;
  /** Five angles, five different roles — the shape a valid plan must have. */
  const fiveAngles = () => [
    { id: "s1", text: "why the mind becomes restless", role: "cause" as const, priority: "primary" as const },
    { id: "s2", text: "what scripture teaches about its nature", role: "scriptural_basis" as const, priority: "primary" as const },
    { id: "s3", text: "practice and detachment as the way", role: "method" as const, priority: "supporting" as const },
    { id: "s4", text: "obstacles a devotee meets in steadying it", role: "practice" as const, priority: "supporting" as const },
    { id: "s5", text: "analogies for the wandering senses", role: "example" as const, priority: "exploratory" as const },
  ];
  const base = fallbackPlan("how do I control my mind");
  const check = (query: string, plan: typeof base) =>
    semanticRejections({ query, plan, maxSubqueries: MAX_SUBQUERIES });

  it("accepts the fallback plan against its own schema", () => {
    expect(QueryPlanSchema.safeParse(base).success).toBe(true);
  });

  it("carries a reference the devotee wrote into the fallback plan — siglum as filter, full form as clue", () => {
    // The `scripture` column stores "BG", never "BG 18.66": the siglum is the
    // only filterable part, and the full reference drives the pinned lookup.
    const plan = fallbackPlan("what does BG 18.66 mean?");
    expect(plan.constraints.scripture_references).toEqual(["BG"]);
    expect(plan.exact_reference).toBe("BG 18.66");
    expect(base.constraints.scripture_references).toEqual([]);
    expect(base.exact_reference).toBeNull();
  });

  it("rejects more subqueries than the plan calls for", () => {
    const plan = {
      ...base,
      subqueries: [
        ...fiveAngles(),
        { id: "s6", text: "one angle too many about steadiness", role: "context" as const, priority: "exploratory" as const },
      ],
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/exactly 5 are required/);
  });

  it("rejects FEWER than five — this is the bug that produced 56 zero-angle searches", () => {
    // Both the old prompt and the old schema said fewer was fine, so the two
    // planner calls that beat the timeout still returned nothing to search with.
    const plan = { ...base, subqueries: fiveAngles().slice(0, 2) };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/exactly 5 are required/);
  });

  it("rejects an EMPTY subquery list — the exact shape production kept accepting", () => {
    expect(check("how do I control my mind", { ...base, subqueries: [] }).join(" "))
      .toMatch(/returned 0 subqueries/);
  });

  it("accepts a plan that spends the budget exactly", () => {
    const plan = { ...base, subqueries: fiveAngles() };
    expect(check("how do I control my mind", plan)).toEqual([]);
  });

  it("rejects five angles that all serve the same purpose", () => {
    // Five rows is not five angles. A repeated role is one angle billed twice.
    const plan = {
      ...base,
      subqueries: fiveAngles().map((s, i) => ({ ...s, role: "cause" as const, id: `s${i}` })),
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/both serve the "cause" purpose/);
  });

  it("sees through a reworded duplicate that differs only by inflection", () => {
    // Without stemming "control" and "controlling" are different tokens, so
    // these two scored 0.33 and sailed past the old 0.85 pair threshold.
    const plan = {
      ...base,
      subqueries: [
        ...fiveAngles().slice(0, 3),
        { id: "s4", text: "control of the restless mind", role: "practice" as const, priority: "supporting" as const },
        { id: "s5", text: "controlling the restless mind", role: "example" as const, priority: "exploratory" as const },
      ],
    };
    expect(check("how do I control my mind", plan).join(" ")).toMatch(/near-identical/);
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
    const plan = { ...base, subqueries: fiveAngles() };
    expect(check("how do I control my mind", plan)).toEqual([]);
  });
});
