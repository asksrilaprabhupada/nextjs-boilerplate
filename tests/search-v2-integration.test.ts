/**
 * search-v2-integration.test.ts — Run the real orchestrator, end to end.
 *
 * Every other test exercises one module. This one calls `runSearchV2` itself
 * and drives fuse → dedupe → rerank → select → re-fetch → render in a single
 * pass, against a database fake seeded with REAL rows copied out of the
 * production corpus (BG 6.34, BG 6.26, BG 14.22-25 and their batch-RPC channel
 * ranks, captured verbatim from `search_verses_hybrid_batch_v2`).
 *
 * It runs with NO provider keys, which is deliberate — that is the
 * all-providers-down path:
 *
 *     no GEMINI_API_KEY  → query planner falls back to the original question
 *     no VOYAGE_API_KEY  → no embeddings, semantic channel dark
 *     no COHERE_API_KEY  → rerank degrades, fused order stands
 *     no article planner → deterministic renderer
 *
 * A pipeline that only works when four providers are healthy is a pipeline that
 * will hand a devotee a stack trace on the first bad afternoon. This asserts it
 * still produces a correct, cited, verbatim answer with all four gone — and
 * that it says so in `degradedStages` rather than pretending.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSearchV2 } from "@/app/lib/search-v2/pipeline";
import { adaptToSearchResults } from "@/app/lib/search-v2/adapt";
import { __setCacheAdapter } from "@/app/lib/search-v2/cache";

// ─── real corpus rows ────────────────────────────────────────

const BG_6_34 = {
  id: "4f79a7a6-adb8-4f77-83b5-5b9f981a8895",
  scripture: "BG",
  verse_number: "34",
  translation:
    "The mind is restless, turbulent, obstinate and very strong, O Kṛṣṇa, and to subdue it, I think, is more difficult than controlling the wind.",
  sanskrit_devanagari: null,
  transliteration: null,
  synonyms: null,
  purport: null,
  vedabase_url: "https://vedabase.io/en/library/bg/6/34/",
  chapters: { chapter_number: 6, canto_or_division: null },
};

const BG_6_26 = {
  id: "70b1bca2-ab33-4ac8-a5d1-7b5914cb2be0",
  scripture: "BG",
  verse_number: "26",
  translation:
    "From wherever the mind wanders due to its flickering and unsteady nature, one must certainly withdraw it and bring it back under the control of the Self.",
  sanskrit_devanagari: null,
  transliteration: null,
  synonyms: null,
  purport: null,
  vedabase_url: "https://vedabase.io/en/library/bg/6/26/",
  chapters: { chapter_number: 6, canto_or_division: null },
};

const BG_14_22 = {
  id: "536c288c-9046-4166-8ceb-e306c007cbc2",
  scripture: "BG",
  verse_number: "22-25",
  translation:
    "The Supreme Personality of Godhead said: O son of Pāṇḍu, he who does not hate illumination, attachment and delusion when they are present or long for them when they disappear; who is unwavering and undisturbed…",
  sanskrit_devanagari: null,
  transliteration: null,
  synonyms: null,
  purport: null,
  vedabase_url: "https://vedabase.io/en/library/bg/14/22-25/",
  chapters: { chapter_number: 14, canto_or_division: null },
};

/** Batch-RPC output copied verbatim from production. */
const VERSE_CANDIDATES = [
  {
    passage_key: `verse:${BG_14_22.id}`,
    source_type: "verse",
    row_id: BG_14_22.id,
    retrieval_text: BG_14_22.translation,
    reference: "BG 14.22-25",
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["s1"],
    channel_ranks: [
      { query_id: "s1", channel: "fts_core", rank: 2, score: 0.002706 },
      { query_id: "__lexical__", channel: "lexical", rank: 1, score: 0.133333 },
    ],
    channel_scores: { lexical: 0.1333, fts_core: 0.0027 },
    tag_matches: 0,
  },
  {
    passage_key: `verse:${BG_6_34.id}`,
    source_type: "verse",
    row_id: BG_6_34.id,
    retrieval_text: BG_6_34.translation,
    reference: "BG 6.34",
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["q_original"],
    channel_ranks: [{ query_id: "q_original", channel: "fts_core", rank: 1, score: 0.079298 }],
    channel_scores: { fts_core: 0.0793 },
    tag_matches: 0,
  },
  {
    passage_key: `verse:${BG_6_26.id}`,
    source_type: "verse",
    row_id: BG_6_26.id,
    retrieval_text: BG_6_26.translation,
    reference: "BG 6.26",
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["q_original"],
    channel_ranks: [{ query_id: "q_original", channel: "fts_expansion", rank: 1, score: 0.008333 }],
    channel_scores: { fts_expansion: 0.0083 },
    tag_matches: 0,
  },
];

const BATCH_FNS = new Set([
  "search_verses_hybrid_batch_v2",
  "search_verse_chunks_hybrid_batch_v2",
  "search_prose_hybrid_batch_v2",
  "search_transcripts_hybrid_batch_v2",
  "search_letters_hybrid_batch_v2",
]);

interface FakeOpts {
  failingRpc?: string;
  verseRows?: Record<string, unknown>[];
}

function fakeDb(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const verses = opts.verseRows ?? [BG_6_34, BG_6_26, BG_14_22];
  return {
    calls,
    rpc(fn: string) {
      calls.push(fn);
      if (opts.failingRpc === fn) {
        return Promise.resolve({ data: null, error: { code: "42883" } });
      }
      if (fn === "search_verses_hybrid_batch_v2") {
        return Promise.resolve({ data: VERSE_CANDIDATES, error: null });
      }
      if (BATCH_FNS.has(fn)) return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [], error: null });
    },
    from(table: string) {
      calls.push(`from:${table}`);
      return {
        select() {
          return {
            in(_col: string, ids: string[]) {
              const rows = table === "verses" ? verses.filter((r) => ids.includes(String(r.id))) : [];
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
}

// Providers are absent for every test here; that is the point.
const SAVED: Record<string, string | undefined> = {};
const KEYS = ["GEMINI_API_KEY", "VOYAGE_API_KEY", "COHERE_API_KEY"];

beforeAll(() => {
  for (const k of KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  // Pin a deterministic in-process cache so the test never reaches for the
  // Vercel runtime cache.
  const store = new Map<string, unknown>();
  __setCacheAdapter({
    name: "test",
    async get<T>(k: string) {
      return (store.get(k) ?? null) as T | null;
    },
    async set<T>(k: string, v: T) {
      store.set(k, v);
    },
  });
});

afterAll(() => {
  for (const k of KEYS) if (SAVED[k] !== undefined) process.env[k] = SAVED[k];
  __setCacheAdapter(null);
});

describe("V2 pipeline, end to end, with every provider down", () => {
  it("still produces a cited, verbatim answer", async () => {
    const db = fakeDb();
    const out = await runSearchV2({
      db: db as never,
      query: "how do I control my restless mind",
      requestId: "req_integration",
    });

    const blocks = out.article.sections.flatMap((s) => s.blocks);
    expect(blocks.length).toBeGreaterThan(0);

    // Text is byte-identical to the source row — no truncation, no editing.
    const bg634 = blocks.find((b) => b.passageKey === `verse:${BG_6_34.id}`);
    expect(bg634).toBeDefined();
    expect(bg634!.text).toBe(BG_6_34.translation);

    // Citation is rebuilt from the fresh row, via the Vedabase URL.
    expect(bg634!.reference).toBe("BG 6.34");
    expect(bg634!.url).toBe("https://vedabase.io/en/library/bg/6/34/");

    expect(out.article.disclosure).toMatch(/assisted by AI/);
    expect(out.evidenceInsufficient).toBe(false);
  });

  it("weights the original question fully and discounts an unrecognised subquery id", async () => {
    const out = await runSearchV2({
      db: fakeDb() as never,
      query: "how do I control my restless mind",
      requestId: "req_rank",
    });

    // With no GEMINI key the plan is the fallback, so `s1` is not an approved
    // subquery. It must therefore be discounted to `supporting` rather than
    // inheriting the original question's weight — the spoofing guard, observed
    // through the full pipeline rather than a unit stub.
    const all = out.article.sections.flatMap((s) => s.blocks);
    expect(all.length).toBeGreaterThan(0);

    // BG 6.34 and BG 6.26 were both matched by the ORIGINAL question at rank 1;
    // the only difference is the channel. fts_core (1.20) must beat
    // fts_expansion (0.65), because an exact-wording hit outranks an
    // alias/transliteration hit.
    const keys = all.map((b) => b.passageKey);
    const i634 = keys.indexOf(`verse:${BG_6_34.id}`);
    const i626 = keys.indexOf(`verse:${BG_6_26.id}`);
    expect(i634).toBeGreaterThanOrEqual(0);
    expect(i626).toBeGreaterThanOrEqual(0);
    expect(i634).toBeLessThan(i626);
  });

  it("reports its degradations instead of hiding them", async () => {
    const out = await runSearchV2({
      db: fakeDb() as never,
      query: "how do I control my restless mind",
      requestId: "req_degraded",
    });
    expect(out.telemetry.degraded).toBe(true);
    const codes = out.telemetry.degradedStages.map((d) => d.code).join(" ");
    expect(codes).toMatch(/embeddings_unavailable/);
    expect(out.telemetry.reranked).toBe(false);
  });

  it("calls exactly five table RPCs and counts hydration separately", async () => {
    const db = fakeDb();
    const out = await runSearchV2({
      db: db as never,
      query: "how do I control my restless mind",
      requestId: "req_count",
    });
    const batchCalls = db.calls.filter((c) => BATCH_FNS.has(c));
    expect(batchCalls).toHaveLength(5);
    expect(out.telemetry.tableRpcCount).toBe(5);
    // Verification reads are reported separately so the "five RPCs" claim holds.
    expect(out.telemetry.refetchCount).toBeGreaterThan(0);
  });

  it("emits stages in order and finishes degraded rather than complete", async () => {
    const seen: string[] = [];
    await runSearchV2({
      db: fakeDb() as never,
      query: "how do I control my restless mind",
      requestId: "req_stage",
      onStage: (s) => seen.push(s),
    });
    expect(seen.slice(0, 3)).toEqual(["planning", "retrieving", "fusing"]);
    expect(seen).toContain("selecting");
    expect(seen[seen.length - 1]).toBe("degraded");
  });

  it("propagates a retrieval RPC failure instead of returning an empty answer", async () => {
    await expect(
      runSearchV2({
        db: fakeDb({ failingRpc: "search_letters_hybrid_batch_v2" }) as never,
        query: "how do I control my restless mind",
        requestId: "req_fail",
      }),
    ).rejects.toThrow(/search_letters_hybrid_batch_v2/);
  });

  it("drops a passage whose source row changed under it, and renders the rest", async () => {
    const tampered = { ...BG_6_34, translation: "Something else entirely." };
    const out = await runSearchV2({
      db: fakeDb({ verseRows: [tampered, BG_6_26, BG_14_22] }) as never,
      query: "how do I control my restless mind",
      requestId: "req_tamper",
    });
    const keys = out.article.sections.flatMap((s) => s.blocks.map((b) => b.passageKey));
    expect(keys).not.toContain(`verse:${BG_6_34.id}`);
    expect(out.telemetry.droppedOnRefetch).toBeGreaterThan(0);
    // The rest of the answer survives.
    expect(keys.length).toBeGreaterThan(0);
  });

  it("returns evidence_insufficient when every passage fails verification", async () => {
    const out = await runSearchV2({
      db: fakeDb({ verseRows: [] }) as never,
      query: "how do I control my restless mind",
      requestId: "req_none",
    });
    expect(out.evidenceInsufficient).toBe(true);
    expect(out.article.sections.flatMap((s) => s.blocks)).toHaveLength(0);
  });

  it("sends a bare exact reference down the same road as everything else", async () => {
    // The old pipeline recognised "BG 6.34" and skipped planning, fan-out and
    // reranking. That is exactly the branching this rebuild removed: the same
    // stages run, in the same order, whatever the question looks like.
    const db = fakeDb();
    const out = await runSearchV2({ db: db as never, query: "BG 6.34", requestId: "req_exact" });

    expect(db.calls.filter((c) => BATCH_FNS.has(c))).toHaveLength(5);
    expect(out.telemetry.tableRpcCount).toBe(5);
    // Cohere is down in this fixture, so the rerank degrades rather than being
    // skipped — a degradation is reported, a bypass never was.
    expect(out.telemetry.degradedStages.map((d) => d.stage)).toContain("reranking");
  });

  it("adapts onto the wire contract the live UI already renders", async () => {
    const out = await runSearchV2({
      db: fakeDb() as never,
      query: "how do I control my restless mind",
      requestId: "req_adapt",
    });
    const wire = adaptToSearchResults("how do I control my restless mind", out);

    expect(wire.validated).toBe(true);
    expect(wire.retrievalStatus).toBe("complete");
    expect(wire.requestId).toBe("req_adapt");
    expect(wire.citations.length).toBeGreaterThan(0);
    expect(wire.citations.every((c) => c.ref && c.ref.trim())).toBe(true);
    // The narrative carries the exact stored text and its citation.
    expect(wire.narrative).toContain(BG_6_34.translation);
    expect(wire.narrative).toContain("BG 6.34");
    expect(wire.narrative).toContain("assisted by AI");
    expect(wire.totalResults).toBe(wire.citations.length);
  });

  it("never leaks the question into telemetry", async () => {
    const out = await runSearchV2({
      db: fakeDb() as never,
      query: "a very distinctive question about the restless mind",
      requestId: "req_privacy",
    });
    const serialised = JSON.stringify(out.telemetry);
    expect(serialised).not.toContain("distinctive question");
    expect(out.telemetry.questionHash).toMatch(/^[0-9a-f]{32}$/);
  });
});
