/**
 * search-v2-integration.test.ts — Run the real orchestrator, end to end.
 *
 * Every other test exercises one module. This one calls `runSearchV2` itself
 * and drives fuse → dedupe → rerank → select → re-fetch → render in a single
 * pass, against a database fake seeded with REAL rows copied out of the
 * production corpus (BG 6.34, BG 6.26, BG 14.22-25 and their batch-RPC channel
 * ranks, captured verbatim from the batched verse retrieval RPC — the shape is
 * unchanged between v2 and v3 apart from the added columns).
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
 * still produces a correct, cited, verbatim answer with all four gone. Provider
 * failures that reduce recall remain in `degradedStages`; article-planner
 * fallback is recorded separately because the deterministic renderer is a
 * complete designed path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { runSearchV2 } from "@/app/lib/search-v2/pipeline";
import { adaptToSearchResults } from "@/app/lib/search-v2/adapt";
import { __setCacheAdapter } from "@/app/lib/search-v2/cache";
import { SearchInfrastructureError } from "@/app/lib/search-v2/errors";
import { retrieveCandidates } from "@/app/lib/search-v2/retrieval";
import {
  fallbackPlan,
  type PrivatePlannerCallUsage,
} from "@/app/lib/search-v2/query-plan";
import { DegradationLog } from "@/app/lib/search-v2/rpc";

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = {
      generateContent: async () => ({
        text: JSON.stringify({
          schema_version: "query-plan-v1",
          intent: "practical_how",
          canonical_query: "how to control the restless mind",
          preserve_terms: ["mind"],
          lexical_phrases: [],
          vocabulary_candidates: ["the mind"],
          subqueries: [
            { id: "s1", text: "why the mind becomes restless", role: "cause", priority: "primary" },
            { id: "s2", text: "scriptural nature of the mind", role: "scriptural_basis", priority: "primary" },
            { id: "s3", text: "practice and detachment for steadiness", role: "method", priority: "supporting" },
            { id: "s4", text: "obstacles in steadying the mind", role: "practice", priority: "supporting" },
            { id: "s5", text: "analogies for the wandering senses", role: "example", priority: "exploratory" },
          ],
          constraints: {
            scripture_references: [],
            source_types: [],
            speaker: null,
            recipient: null,
            location: null,
            date_from: null,
            date_to: null,
          },
          possible_false_assumption: false,
        }),
        usageMetadata: {
          promptTokenCount: 777,
          candidatesTokenCount: 333,
          thoughtsTokenCount: 0,
          toolUsePromptTokenCount: 0,
          totalTokenCount: 1_110,
        },
      }),
    };
  },
}));

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

const BATCH_FUNCTIONS = [
  "search_transcripts_hybrid_batch_v3",
  "search_verses_hybrid_batch_v3",
  "search_prose_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
  "search_letters_hybrid_batch_v3",
] as const;

const BATCH_FNS = new Set<string>(BATCH_FUNCTIONS);

const PRIVATE_DB_MESSAGE = "private SQL function body and argument values";
const PRIVATE_DB_DETAILS = "relation internal_search_vectors is unavailable";

interface FakeOpts {
  /** Every named RPC resolves the way supabase-js does after a DB response. */
  failingRpcs?: ReadonlySet<string>;
  /** Named RPCs return an anomalous blank success (`data: null`, no error). */
  nullDataRpcs?: ReadonlySet<string>;
  verseRows?: Record<string, unknown>[];
  /** Rows direct_verse_lookup returns — the exact-reference pin's source. */
  directRows?: Record<string, unknown>[];
  /**
   * When true, the verse RPC honours its scripture constraint the way the
   * real one does when the filter matches nothing: zero rows. Lets the tests
   * drive the fail-open path.
   */
  scriptureFilterEmpties?: boolean;
  transcriptCandidates?: Record<string, unknown>[];
}

function fakeDb(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const verses = opts.verseRows ?? [BG_6_34, BG_6_26, BG_14_22];
  return {
    calls,
    rpcCalls,
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push(fn);
      rpcCalls.push({ fn, args: args ?? {} });
      if (opts.failingRpcs?.has(fn)) {
        return Promise.resolve({
          data: null,
          error: {
            code: "42883",
            message: `${PRIVATE_DB_MESSAGE}: ${fn}`,
            details: PRIVATE_DB_DETAILS,
            hint: "private migration name",
          },
        });
      }
      if (opts.nullDataRpcs?.has(fn)) {
        return Promise.resolve({ data: null, error: null });
      }
      if (fn === "search_verses_hybrid_batch_v3") {
        const cons = (args?.p_constraints ?? {}) as { scripture_references?: string[] };
        if (opts.scriptureFilterEmpties && (cons.scripture_references?.length ?? 0) > 0) {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: VERSE_CANDIDATES, error: null });
      }
      if (fn === "search_transcripts_hybrid_batch_v3" && opts.transcriptCandidates) {
        return Promise.resolve({ data: opts.transcriptCandidates, error: null });
      }
      if (fn === "direct_verse_lookup") {
        return Promise.resolve({ data: opts.directRows ?? [], error: null });
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

  it("keeps evaluator-private planner calls out of telemetry and pipeline output", async () => {
    const priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "offline-test-key";
    try {
      const privateCalls: PrivatePlannerCallUsage[] = [];
      const out = await runSearchV2({
        db: fakeDb() as never,
        query: "how do I control my restless mind",
        requestId: "req_private_planner_accounting",
        captureDiagnostics: true,
        privatePlannerCallUsageObserver: (event) => {
          privateCalls.push({ ...event });
        },
        privateArticlePlanner: async () => ({
          plan: null,
          source: "deterministic_fallback",
          rejections: ["offline privacy test"],
        }),
      });

      expect(privateCalls).toEqual([{
        attempt: 1,
        responseReceived: true,
        promptTokenCount: 777,
        candidatesTokenCount: 333,
        thoughtsTokenCount: 0,
        toolUsePromptTokenCount: 0,
        totalTokenCount: 1_110,
      }]);
      expect(out.telemetry.planUsage).toMatchObject({
        attempts: 1,
        promptTokens: 777,
        outputTokens: 333,
        thoughtsTokens: 0,
        totalTokens: 1_110,
      });
      const serialized = JSON.stringify(out);
      for (const privateField of [
        "responseReceived",
        "promptTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
        "toolUsePromptTokenCount",
        "totalTokenCount",
      ]) {
        expect(serialized).not.toContain(`"${privateField}"`);
      }
    } finally {
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
    }
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
    expect(out.article.planned).toBe(false);
    expect(out.telemetry.models).toMatchObject({
      queryPlanner: null,
      articlePlanner: null,
    });
    expect(out.telemetry.degradedStages).toContainEqual({
      stage: "planning",
      source: "gemini_query_planner",
      // The specific reason, not the old catch-all `plan_rejected`. With no
      // GEMINI_API_KEY in the test environment, that reason is "no key" — which
      // is a deployment fault, not a model that answered badly.
      code: "plan_api_key_absent",
    });
    expect(out.telemetry.degradedStages.some(
      (item) => item.source === "gemini_article_planner",
    )).toBe(false);
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

  it("runs table RPCs one at a time in measured heaviest-first order", async () => {
    const base = fakeDb();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const db = {
      ...base,
      async rpc(fn: string, args?: Record<string, unknown>) {
        if (!BATCH_FNS.has(fn)) return base.rpc(fn, args);
        started.push(fn);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          // A real async boundary makes this fail with maxActive=5 if the
          // orchestrator ever starts the source promises together again.
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          return await base.rpc(fn, args);
        } finally {
          active -= 1;
        }
      },
    };

    const out = await runSearchV2({
      db: db as never,
      query: "how do I control my restless mind",
      requestId: "req_serial_sources",
    });

    expect(started).toEqual(BATCH_FUNCTIONS);
    expect(maxActive).toBe(1);
    expect(out.telemetry.tableRpcCount).toBe(5);
    expect(base.rpcCalls.filter((call) => BATCH_FNS.has(call.fn)).map((call) => ({
      fn: call.fn,
      outer: call.args.p_limit,
      semantic: call.args.p_semantic_limit,
    }))).toEqual([
      { fn: "search_transcripts_hybrid_batch_v3", outer: 150, semantic: 300 },
      { fn: "search_verses_hybrid_batch_v3", outer: 200, semantic: 300 },
      { fn: "search_prose_hybrid_batch_v3", outer: 120, semantic: 300 },
      { fn: "search_verse_chunks_hybrid_batch_v3", outer: 150, semantic: 300 },
      { fn: "search_letters_hybrid_batch_v3", outer: 80, semantic: 300 },
    ]);
    expect(out.telemetry.sourceRetrieval.map((source) => source.internalFunction)).toEqual(
      BATCH_FUNCTIONS,
    );
  });

  it("serializes a filtered source subset in measured heaviest-first order", async () => {
    const base = fakeDb();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const db = {
      ...base,
      async rpc(fn: string, args?: Record<string, unknown>) {
        if (!BATCH_FNS.has(fn)) return base.rpc(fn, args);
        started.push(fn);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          return await base.rpc(fn, args);
        } finally {
          active -= 1;
        }
      },
    };
    const plan = fallbackPlan("teachings from books, talks, and letters");
    plan.constraints.source_types = ["letter", "book", "conversation"];

    const out = await retrieveCandidates({
      db: db as never,
      original: "teachings from books, talks, and letters",
      plan,
      requestId: "req_serial_subset",
      degraded: new DegradationLog("req_serial_subset"),
    });
    const expected = [
      "search_transcripts_hybrid_batch_v3",
      "search_prose_hybrid_batch_v3",
      "search_letters_hybrid_batch_v3",
    ];

    expect(started).toEqual(expected);
    expect(maxActive).toBe(1);
    expect(out.tableRpcCount).toBe(3);
    expect(out.tableRpcAttemptCount).toBe(3);
    expect(out.sourceRetrieval.map((source) => source.internalFunction)).toEqual(expected);
  });

  it("retains mixed, guest-only, and unlabelled transcript evidence", async () => {
    const mixedText = [
      "Dr. Patel: guest sentinel.",
      "Prabhupāda: This canonical answer remains.",
      "Guest: another guest sentinel.",
    ].join("\n");
    const candidate = (id: string, text: string) => ({
      passage_key: `lecture:${id}`,
      source_type: "lecture",
      row_id: id,
      retrieval_text: text,
      reference: "Room Conversation",
      speaker: null,
      recipient: null,
      occurred_on: "1974-01-01",
      location: "Bombay",
      matched_query_ids: ["q_original"],
      channel_ranks: [{ query_id: "q_original", channel: "fts_core", rank: 1, score: 1 }],
      channel_scores: { fts_core: 1 },
      tag_matches: 0,
    });
    const db = fakeDb({
      transcriptCandidates: [
        candidate("mixed", mixedText),
        candidate("guest", "Dr. Patel: guest-only sentinel."),
        candidate("unknown", "Wholly unlabelled continuation."),
      ],
    });
    const plan = fallbackPlan("control the mind in conversations");
    plan.constraints.source_types = ["conversation"];

    const out = await retrieveCandidates({
      db: db as never,
      original: "control the mind in conversations",
      plan,
      requestId: "req_complete_transcripts",
      degraded: new DegradationLog("req_complete_transcripts"),
    });

    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toHaveLength(3);
    expect(out.groups[0].map((row) => row.retrieval_text)).toEqual([
      mixedText,
      "Dr. Patel: guest-only sentinel.",
      "Wholly unlabelled continuation.",
    ]);
    expect(out.groups[0].map((row) => row.speaker)).toEqual([
      "Dr. Patel · Śrīla Prabhupāda · Guest",
      "Dr. Patel",
      null,
    ]);
    expect(out.groups[0].map((row) => row.speakerUnidentified)).toEqual([false, false, true]);
    expect(out.sourceRetrieval[0]).toMatchObject({
      rawCandidateCount: 3,
      candidateCount: 3,
    });
    expect(db.rpcCalls[0].args.p_constraints).not.toHaveProperty("speaker_only");
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

  it("returns a visibly degraded partial answer when one source fails and four succeed", async () => {
    const failedFn = "search_transcripts_hybrid_batch_v3";
    const db = fakeDb({ failingRpcs: new Set([failedFn]) });
    const out = await runSearchV2({
      db: db as never,
      query: "how do I control my restless mind",
      requestId: "req_partial",
    });

    expect(out.evidenceInsufficient).toBe(false);
    expect(out.article.sections.flatMap((section) => section.blocks).length).toBeGreaterThan(0);
    expect(out.telemetry.tableRpcCount).toBe(5);
    expect(out.telemetry.tableRpcAttemptCount).toBe(5);
    expect(out.telemetry.degradedSources).toEqual(["Lectures and conversations"]);

    const sourceTelemetry = out.telemetry.sourceRetrieval;
    expect(sourceTelemetry).toHaveLength(5);
    expect(sourceTelemetry.filter((source) => source.success)).toHaveLength(4);
    const failed = sourceTelemetry.filter((source) => !source.success);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      source: "Lectures and conversations",
      internalFunction: failedFn,
      operation: "initial",
      success: false,
      code: "42883",
      candidateCount: null,
      attemptCount: 1,
    });

    for (const source of sourceTelemetry) {
      const rpcCall = db.rpcCalls.find((call) => call.fn === source.internalFunction);
      expect(rpcCall, `missing captured call for ${source.internalFunction}`).toBeDefined();
      expect(Number.isFinite(source.durationMs)).toBe(true);
      expect(source.durationMs).toBeGreaterThanOrEqual(0);
      expect(source.outerLimit).toBe(rpcCall!.args.p_limit);
      expect(source.semanticLimit).toBe(rpcCall!.args.p_semantic_limit);
      expect(source.outerLimit).toBeGreaterThan(0);
      expect(source.semanticLimit).toBeGreaterThan(0);
      expect(source.attemptCount).toBe(1);
      expect(source.attempts).toHaveLength(1);
      expect(source.attempts[0].attempt).toBe(1);
      expect(source.attempts[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(source.attempts[0].outcome).toBe(source.success ? "success" : "response_error");
    }

    const wire = adaptToSearchResults("how do I control my restless mind", out);
    expect(wire.retrievalStatus).toBe("degraded");
    expect(wire.degradedSources).toEqual([
      { source: "Lectures and conversations", reason: "temporarily unavailable" },
    ]);
    const serialised = JSON.stringify(wire);
    expect(serialised).not.toContain(failedFn);
    expect(serialised).not.toContain("42883");
    expect(serialised).not.toContain(PRIVATE_DB_MESSAGE);
    expect(serialised).not.toContain(PRIVATE_DB_DETAILS);
    expect(serialised).not.toContain("sourceRetrieval");
    expect(serialised).not.toContain("internalFunction");
  });

  it("treats a blank null/no-error source response as malformed, never as empty evidence", async () => {
    const failedFn = "search_transcripts_hybrid_batch_v3";
    const db = fakeDb({ nullDataRpcs: new Set([failedFn]) });
    const out = await runSearchV2({
      db: db as never,
      query: "how do I control my restless mind",
      requestId: "req_null_partial",
    });

    expect(out.evidenceInsufficient).toBe(false);
    expect(out.telemetry.degraded).toBe(true);
    expect(out.telemetry.degradedSources).toEqual(["Lectures and conversations"]);
    const failed = out.telemetry.sourceRetrieval.find(
      (source) => source.internalFunction === failedFn,
    );
    expect(failed).toMatchObject({
      success: false,
      code: "invalid_response",
      candidateCount: null,
      attemptCount: 1,
    });
    expect(failed?.attempts).toEqual([
      expect.objectContaining({ outcome: "invalid_response", code: "invalid_response" }),
    ]);

    const wire = adaptToSearchResults("how do I control my restless mind", out);
    expect(wire).toMatchObject({
      degraded: true,
      retrievalStatus: "degraded",
      degradedSources: [
        { source: "Lectures and conversations", reason: "temporarily unavailable" },
      ],
    });
    expect(JSON.stringify(wire)).not.toContain("invalid_response");
    expect(JSON.stringify(wire)).not.toContain(failedFn);
  });

  it("turns five blank null/no-error responses into one real infrastructure failure", async () => {
    const db = fakeDb({ nullDataRpcs: new Set(BATCH_FUNCTIONS) });
    let caught: unknown;

    try {
      await runSearchV2({
        db: db as never,
        query: "how do I control my restless mind",
        requestId: "req_all_null",
      });
    } catch (error) {
      caught = error;
    }

    expect(db.calls.filter((call) => BATCH_FNS.has(call))).toEqual(BATCH_FUNCTIONS);
    expect(caught).toBeInstanceOf(SearchInfrastructureError);
    const error = caught as SearchInfrastructureError;
    expect(error).toMatchObject({
      requestId: "req_all_null",
      source: "all_requested_sources",
      databaseCode: null,
      transportCode: null,
      internalCode: "invalid_response",
      attemptCount: 5,
    });
    expect(error.sourceFailures).toHaveLength(5);
    expect(error.sourceFailures.every((failure) =>
      failure.internalCode === "invalid_response"
      && failure.databaseCode === null
      && failure.transportCode === null)).toBe(true);
    const publicWire = JSON.stringify(error.toPublicJSON());
    expect(publicWire).not.toContain("invalid_response");
    for (const fn of BATCH_FUNCTIONS) expect(publicWire).not.toContain(fn);
  });

  it("waits for and reports all five source failures as one structured outage", async () => {
    const db = fakeDb({ failingRpcs: new Set(BATCH_FUNCTIONS) });
    let caught: unknown;

    try {
      await runSearchV2({
        db: db as never,
        query: "how do I control my restless mind",
        requestId: "req_all_fail",
      });
    } catch (error) {
      caught = error;
    }

    expect(db.calls.filter((call) => BATCH_FNS.has(call))).toEqual(BATCH_FUNCTIONS);
    expect(caught).toBeInstanceOf(SearchInfrastructureError);
    const error = caught as SearchInfrastructureError;
    expect(error).toMatchObject({
      requestId: "req_all_fail",
      stage: "retrieval:batch",
      source: "all_requested_sources",
      databaseCode: "42883",
      transportCode: null,
      attemptCount: 5,
    });
    expect(error.sourceFailures).toHaveLength(5);
    expect(error.sourceFailures.map((failure) => failure.source)).toEqual(BATCH_FUNCTIONS);
    for (const failure of error.sourceFailures) {
      expect(failure).toMatchObject({
        stage: `retrieval:batch:${failure.source}`,
        databaseCode: "42883",
        transportCode: null,
        attemptCount: 1,
      });
      expect(Number.isFinite(failure.durationMs)).toBe(true);
      expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError);

    const publicWire = error.toPublicJSON();
    expect(publicWire).toEqual({
      error: "Search is temporarily unavailable. Please try again shortly.",
      code: "search_infrastructure_error",
      request_id: "req_all_fail",
    });
    const serialised = JSON.stringify(publicWire);
    for (const fn of BATCH_FUNCTIONS) expect(serialised).not.toContain(fn);
    expect(serialised).not.toContain("42883");
    expect(serialised).not.toContain(PRIVATE_DB_MESSAGE);
    expect(serialised).not.toContain(PRIVATE_DB_DETAILS);
    expect(serialised).not.toContain("sourceFailures");
  });

  it("does not constraint-fail-open a scripture source that failed", async () => {
    const failedFn = "search_verse_chunks_hybrid_batch_v3";
    const db = fakeDb({
      failingRpcs: new Set([failedFn]),
      scriptureFilterEmpties: true,
      transcriptCandidates: [
        {
          passage_key: "lecture:bbbbbbbb-0000-0000-0000-000000000000",
          source_type: "lecture",
          row_id: "bbbbbbbb-0000-0000-0000-000000000000",
          retrieval_text:
            "A recorded talk paragraph long enough to prove that another source returned evidence while one scripture source failed.",
          reference: "Lecture",
          speaker: null,
          recipient: null,
          occurred_on: null,
          location: null,
          matched_query_ids: ["q_original"],
          channel_ranks: [{ query_id: "q_original", channel: "fts_core", rank: 1 }],
          channel_scores: {},
          tag_matches: 0,
        },
      ],
    });

    const out = await runSearchV2({
      db: db as never,
      query: "what does BG 6.34 mean?",
      requestId: "req_failed_scripture",
    });

    const batchCalls = db.calls.filter((call) => BATCH_FNS.has(call));
    expect(batchCalls).toHaveLength(6);
    expect(batchCalls.filter((call) => call === failedFn)).toHaveLength(1);
    expect(batchCalls.filter((call) => call === "search_verses_hybrid_batch_v3")).toHaveLength(2);
    expect(out.telemetry.tableRpcCount).toBe(6);
    expect(out.telemetry.tableRpcAttemptCount).toBe(6);
    expect(out.telemetry.sourceRetrieval).toHaveLength(6);
    expect(out.telemetry.sourceRetrieval.filter(
      (source) => source.operation === "constraint_fail_open",
    ).map((source) => source.internalFunction)).toEqual(["search_verses_hybrid_batch_v3"]);
    expect(out.telemetry.degradedSources).toEqual(["Purports"]);
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

  it("pins the exact verse first when the devotee asked for it by reference", async () => {
    const db = fakeDb({ directRows: [BG_6_34] });
    const out = await runSearchV2({ db: db as never, query: "BG 6.34", requestId: "req_pin" });

    expect(db.calls).toContain("direct_verse_lookup");
    expect(out.telemetry.pinnedExactReference).toBe(true);
    // First in the main tier regardless of any score, verified verbatim.
    expect(out.passages[0]?.reference).toBe("BG 6.34");
    expect(out.passages[0]?.text).toBe(BG_6_34.translation);
  });

  it("does not call direct_verse_lookup when no reference was written", async () => {
    const db = fakeDb();
    await runSearchV2({
      db: db as never,
      query: "how do I control my restless mind",
      requestId: "req_no_pin",
    });
    expect(db.calls).not.toContain("direct_verse_lookup");
  });

  it("fails OPEN when a scripture filter empties the scripture sources", async () => {
    // The filter says "BG" but (as with the real bug this guards against) the
    // constrained calls return nothing while transcripts found rows. An empty
    // result caused by a filter is a bug, never an answer: the two scripture
    // calls re-run unfiltered and the verses come back.
    const db = fakeDb({
      scriptureFilterEmpties: true,
      transcriptCandidates: [
        {
          passage_key: "lecture:aaaaaaaa-0000-0000-0000-000000000000",
          source_type: "lecture",
          row_id: "aaaaaaaa-0000-0000-0000-000000000000",
          retrieval_text:
            "A recorded talk paragraph long enough to clear the junk floor and stand in for the 861 unconstrained survivors of the original incident.",
          reference: "Lecture",
          speaker: null,
          recipient: null,
          occurred_on: null,
          location: null,
          matched_query_ids: ["q_original"],
          channel_ranks: [{ query_id: "q_original", channel: "fts_core", rank: 1 }],
          channel_scores: {},
          tag_matches: 0,
        },
      ],
    });
    const out = await runSearchV2({
      db: db as never,
      query: "what does BG 6.34 mean?",
      requestId: "req_failopen",
    });

    // Five first-round calls plus the two re-issued scripture calls, all in the
    // same stable serial order.
    expect(db.calls.filter((c) => BATCH_FNS.has(c))).toEqual([
      ...BATCH_FUNCTIONS,
      "search_verses_hybrid_batch_v3",
      "search_verse_chunks_hybrid_batch_v3",
    ]);
    expect(out.telemetry.tableRpcCount).toBe(7);
    const refs = out.passages.map((p) => p.reference);
    expect(refs).toContain("BG 6.34");
  });

  it("adapts onto the wire contract: the words themselves, never just names", async () => {
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
    // The honest total spans both tiers (everything fits in main here).
    expect(wire.totalResults).toBe(wire.passages.length + wire.additional.length);
    expect(wire.additionalCount).toBe(wire.additional.length);

    // WORDS, NOT NAMES. This must fail if `passages` is ever empty or
    // text-free — that is exactly the blank-page bug.
    expect(wire.passages.length).toBeGreaterThan(0);
    for (const p of wire.passages) {
      expect(p.text, `passage ${p.reference ?? p.label} arrived without its words`).toBeTruthy();
      expect(p.text.trim().length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }

    // The exact stored translation travels in the response, with its citation.
    const bg634 = wire.passages.find((p) => p.reference === "BG 6.34");
    expect(bg634).toBeDefined();
    expect(bg634!.text).toBe(BG_6_34.translation);
    expect(bg634!.url).toBe("https://vedabase.io/en/library/bg/6/34/");
    expect(JSON.stringify(wire)).not.toMatch(/\b(?:articleVerseIds|id)\b/);
  });

  it("never leaks the question into telemetry", async () => {
    const out = await runSearchV2({
      db: fakeDb() as never,
      query: "a very distinctive question about the restless mind",
      requestId: "req_privacy",
    });
    const serialised = JSON.stringify(out.telemetry);
    expect(serialised).not.toContain("distinctive question");
    expect(out.telemetry.questionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
