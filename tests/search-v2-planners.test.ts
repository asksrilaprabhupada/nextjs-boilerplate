/**
 * search-v2-planners.test.ts — The planner call loops, with injected clients.
 *
 * `semanticRejections` and `articleRejections` are already covered as pure
 * functions. What was not covered is the loop AROUND them: does a malformed
 * body actually earn exactly one retry, does a semantically-rejected plan get
 * thrown away rather than used, and does every failure path really land on the
 * safe fallback instead of propagating?
 *
 * That loop is the last thing standing between a bad model response and a
 * devotee, so it is tested against a fake client rather than trusted.
 */
import { describe, it, expect } from "vitest";
import {
  planQuery,
  fallbackPlan,
  REQUIRED_SUBQUERIES,
  QUERY_PLANNER_THINKING_BUDGET,
  QUERY_PLANNER_MAX_OUTPUT_TOKENS,
} from "@/app/lib/search-v2/query-plan";
import {
  ARTICLE_PLANNER_MAX_OUTPUT_TOKENS,
  ARTICLE_PLANNER_THINKING_BUDGET,
  planArticle,
  DISCLOSURE,
} from "@/app/lib/search-v2/article-plan";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";

/** A client that returns a scripted body per call, or throws. */
function scriptedClient(bodies: (string | Error)[]) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const configs: Record<string, unknown>[] = [];
  return {
    calls,
    prompts,
    configs,
    models: {
      async generateContent(args: Record<string, unknown>) {
        calls.push(String(args.model ?? ""));
        prompts.push(String(args.contents ?? ""));
        configs.push((args.config ?? {}) as Record<string, unknown>);
        const next = bodies.shift();
        if (next instanceof Error) throw next;
        return {
          text: next ?? "",
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 300,
            thoughtsTokenCount: 0,
            totalTokenCount: 800,
          },
        };
      },
    },
  };
}

const QUESTION = "how do I control my restless mind";
/** The one fan-out size: exactly this many angles, every question, every time. */
const MAX_SUBQUERIES = REQUIRED_SUBQUERIES;

/** Five angles, five different roles, no two of them the same question twice. */
const FIVE_ANGLES = [
  { id: "s1", text: "why the mind becomes restless and uncontrolled", role: "cause", priority: "primary" },
  { id: "s2", text: "what the scriptures teach about the nature of the mind", role: "scriptural_basis", priority: "primary" },
  { id: "s3", text: "practice and detachment as the way to steadiness", role: "method", priority: "supporting" },
  { id: "s4", text: "obstacles a devotee meets in steadying it", role: "practice", priority: "supporting" },
  { id: "s5", text: "analogies for the wandering senses", role: "example", priority: "exploratory" },
];

function goodPlan(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: "query-plan-v1",
    intent: "practical_how",
    canonical_query: "how to control the restless mind",
    preserve_terms: ["mind"],
    lexical_phrases: [],
    vocabulary_candidates: ["the mind"],
    subqueries: FIVE_ANGLES,
    constraints: {
      scripture_references: [], source_types: [], speaker: null,
      recipient: null, location: null, date_from: null, date_to: null,
    },
    possible_false_assumption: false,
    ...over,
  });
}

describe("query planner loop", () => {
  it("accepts a well-formed plan on the first call", async () => {
    const client = scriptedClient([goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.source).toBe("model");
    expect(out.plan.subqueries).toHaveLength(REQUIRED_SUBQUERIES);
    expect(out.failureKind).toBeNull();
    expect(client.calls).toHaveLength(1);
  });

  it("runs with thinking OFF — the cause of every 3 s planner timeout", async () => {
    const client = scriptedClient([goodPlan()]);
    await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(client.configs[0].thinkingConfig).toEqual({
      thinkingBudget: QUERY_PLANNER_THINKING_BUDGET,
    });
    expect(QUERY_PLANNER_THINKING_BUDGET).toBe(0);
    expect(client.configs[0].maxOutputTokens).toBe(QUERY_PLANNER_MAX_OUTPUT_TOKENS);
  });

  it("tells the model five angles are required, never that fewer will do", async () => {
    const client = scriptedClient([goodPlan()]);
    await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(client.prompts[0]).toContain("Return EXACTLY 5 subqueries");
    expect(client.prompts[0]).not.toMatch(/Returning fewer is fine/);
    const schema = client.configs[0].responseJsonSchema as Record<string, never>;
    const subqueries = (schema.properties as Record<string, Record<string, number>>).subqueries;
    expect(subqueries.minItems).toBe(REQUIRED_SUBQUERIES);
    expect(subqueries.maxItems).toBe(REQUIRED_SUBQUERIES);
  });

  it("records what the planning stage cost — attempts, tokens and wall-clock", async () => {
    const client = scriptedClient([goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.usage.attempts).toBe(1);
    expect(out.usage.promptTokens).toBe(500);
    expect(out.usage.outputTokens).toBe(300);
    // Non-zero here would mean thinkingBudget: 0 stopped being honoured.
    expect(out.usage.thoughtsTokens).toBe(0);
    expect(out.usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("REJECTS a plan carrying no angles — the exact response production accepted twice", async () => {
    // An empty list is repairable, so it earns the one retry; a second empty
    // list is a recorded failure, never a quiet success as it was before.
    const empty = goodPlan({ subqueries: [] });
    const client = scriptedClient([empty, empty]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(client.calls).toHaveLength(2);
    expect(out.source).toBe("fallback_original_only");
    expect(out.failureKind).toBe("too_few_angles");
  });

  it("repairs a short plan on the retry rather than searching with one query", async () => {
    const client = scriptedClient([goodPlan({ subqueries: FIVE_ANGLES.slice(0, 2) }), goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.source).toBe("model");
    expect(out.plan.subqueries).toHaveLength(REQUIRED_SUBQUERIES);
  });

  it("retries ONCE when the angles repeat one another, and takes the repaired plan", async () => {
    const duplicated = goodPlan({
      subqueries: [
        ...FIVE_ANGLES.slice(0, 3),
        { id: "s4", text: "control of the restless mind", role: "practice", priority: "supporting" },
        { id: "s5", text: "controlling the restless mind", role: "example", priority: "exploratory" },
      ],
    });
    const client = scriptedClient([duplicated, goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(client.calls).toHaveLength(2);
    expect(out.source).toBe("model");
    expect(out.usage.attempts).toBe(2);
    // The second attempt is told what was wrong; a blind retry repeats it.
    expect(client.prompts[1]).toContain("YOUR PREVIOUS PLAN WAS REJECTED");
  });

  it("retries at most once, then falls back and says the angles were duplicates", async () => {
    const duplicated = goodPlan({
      subqueries: FIVE_ANGLES.map((angle) => ({ ...angle, role: "cause" })),
    });
    const client = scriptedClient([duplicated, duplicated, goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(client.calls).toHaveLength(2);
    expect(out.source).toBe("fallback_original_only");
    expect(out.failureKind).toBe("near_duplicate_angles");
  });

  it("does NOT retry a misread question — a second look is not a repair", async () => {
    const invented = goodPlan({
      constraints: {
        scripture_references: [], source_types: [], speaker: null,
        recipient: "Brahmananda", location: null, date_from: null, date_to: null,
      },
    });
    const client = scriptedClient([invented, goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(client.calls).toHaveLength(1);
    expect(out.failureKind).toBe("semantic_rejected");
  });

  it("names the failure kind for each way the call can fail", async () => {
    const timeout = await planQuery(QUESTION, MAX_SUBQUERIES, {
      client: {
        models: {
          generateContent: () => new Promise(() => {}) as Promise<{ text?: string }>,
        },
      },
      timeoutMs: 10,
    });
    expect(timeout.failureKind).toBe("timeout");

    const truncated = await planQuery(QUESTION, MAX_SUBQUERIES, {
      client: scriptedClient(['{"schema_version":"query-pl']),
    });
    expect(truncated.failureKind).toBe("invalid_json");

    const empty = await planQuery(QUESTION, MAX_SUBQUERIES, { client: scriptedClient([""]) });
    expect(empty.failureKind).toBe("empty_body");

    const wrongShape = await planQuery(QUESTION, MAX_SUBQUERIES, {
      client: scriptedClient(['{"schema_version":"query-plan-v1"}']),
    });
    expect(wrongShape.failureKind).toBe("schema_rejected");

    const outage = await planQuery(QUESTION, MAX_SUBQUERIES, {
      client: scriptedClient([new Error("503")]),
    });
    expect(outage.failureKind).toBe("provider_error");
  });

  it("does NOT retry a truncated body — one attempt, then the honest fallback", async () => {
    // A retry doubled the pre-retrieval cost on every planner outage while
    // buying nothing the fallback plan does not already provide.
    const client = scriptedClient(['{"schema_version":"query-pl', goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.source).toBe("fallback_original_only");
    expect(client.calls).toHaveLength(1);
    expect(out.rejections.length).toBeGreaterThan(0);
    expect(out.failureKind).toBe("invalid_json");
  });

  it("falls back to the original question after one failure — never throws", async () => {
    const client = scriptedClient([new Error("503")]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.source).toBe("fallback_original_only");
    expect(out.plan.subqueries).toHaveLength(0);
    expect(out.plan.canonical_query).toBe(QUESTION);
    expect(client.calls).toHaveLength(1);
  });

  it("discards a schema-valid plan that fails semantic validation", async () => {
    // Well-formed JSON, but it invented a recipient the devotee never mentioned.
    const invented = goodPlan({
      constraints: {
        scripture_references: [], source_types: [], speaker: null,
        recipient: "Brahmananda", location: null, date_from: null, date_to: null,
      },
    });
    const client = scriptedClient([invented]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.source).toBe("fallback_original_only");
    expect(out.rejections.join(" ")).toMatch(/invented recipient/);
  });

  it("plans a bare scripture reference like any other question", async () => {
    // This used to skip the planner entirely, so "BG 18.66" and "what does BG
    // 18.66 mean" were answered by two different pipelines. One road now: the
    // SIGLUM becomes the retrieval filter (the scripture column stores "BG",
    // never "BG 18.66") and the full reference rides in exact_reference.
    const client = scriptedClient([
      goodPlan({
        intent: "exact_reference",
        canonical_query: "BG 18.66",
        preserve_terms: ["BG 18.66"],
        // A bare reference is planned like anything else: five angles, so the
        // verse arrives with its purport, its lectures and its letters.
        subqueries: [
          { id: "s1", text: "surrender as the final instruction", role: "scriptural_basis", priority: "primary" },
          { id: "s2", text: "why abandoning other duties is enjoined", role: "cause", priority: "primary" },
          { id: "s3", text: "how a devotee practises full surrender", role: "method", priority: "supporting" },
          { id: "s4", text: "purport commentary on that instruction", role: "context", priority: "supporting" },
          { id: "s5", text: "lectures given on this same passage", role: "example", priority: "exploratory" },
        ],
      }),
    ]);
    const out = await planQuery("BG 18.66", MAX_SUBQUERIES, { client });
    expect(client.calls).toHaveLength(1);
    expect(out.plan.subqueries).toHaveLength(REQUIRED_SUBQUERIES);
    expect(out.source).toBe("model");
    expect(out.plan.constraints.scripture_references).toEqual(["BG"]);
    expect(out.plan.exact_reference).toBe("BG 18.66");
  });

  it("falls back when no API key is configured", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const out = await planQuery(QUESTION, MAX_SUBQUERIES);
      expect(out.source).toBe("fallback_original_only");
      expect(out.rejections.join(" ")).toMatch(/GEMINI_API_KEY absent/);
      expect(out.failureKind).toBe("api_key_absent");
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it("produces a fallback plan that is itself valid", () => {
    const plan = fallbackPlan(QUESTION);
    expect(plan.schema_version).toBe("query-plan-v1");
    expect(plan.subqueries).toEqual([]);
  });
});

// ─── article planner ─────────────────────────────────────────

const PASSAGES = [
  { passageKey: "verse:1", sourceType: "verse", reference: "BG 6.6", date: null, recipient: null, location: null, text: "For him who has conquered the mind…" },
  { passageKey: "purport:1", sourceType: "purport", reference: "BG 6.6", date: null, recipient: null, location: null, text: "The purport explains…" },
] as unknown as VerifiedPassage[];

function goodArticle(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: "article-plan-v1",
    article_type: "guided_study",
    title: "Controlling the Mind: Practice and Detachment",
    opening: { kind: "direct_source", passage_id: "verse:1" },
    direct_answer_passage_ids: ["verse:1"],
    sections: [
      { heading_key: "foundation", short_subject: "the mind", passage_ids: ["verse:1"], transition_type: "none" },
      { heading_key: "explanation", short_subject: "conquering it", passage_ids: ["purport:1"], transition_type: "deepening" },
    ],
    closing: { kind: "none", passage_ids: [] },
    disclosure: DISCLOSURE,
    ...over,
  });
}

describe("article planner loop", () => {
  it("accepts a well-formed plan", async () => {
    const client = scriptedClient([goodArticle()]);
    const out = await planArticle(QUESTION, PASSAGES, { client });
    expect(out.source).toBe("model");
    expect(out.plan?.sections).toHaveLength(2);
  });

  it("falls back to the deterministic renderer rather than using a bad plan", async () => {
    // References a passage id it was never given — the invented-citation case.
    const invented = goodArticle({
      sections: [{ heading_key: "foundation", short_subject: "x", passage_ids: ["verse:999"], transition_type: "none" }],
    });
    const client = scriptedClient([invented, invented]);
    const out = await planArticle(QUESTION, PASSAGES, { client });
    expect(out.plan).toBeNull();
    expect(out.source).toBe("deterministic_fallback");
    expect(out.rejections.join(" ")).toMatch(/never supplied/);
  });

  it("rejects a plan that reworded the disclosure", async () => {
    const reworded = goodArticle({ disclosure: "Written with AI assistance." });
    const client = scriptedClient([reworded, reworded]);
    const out = await planArticle(QUESTION, PASSAGES, { client });
    expect(out.plan).toBeNull();
  });

  it("never calls the model when there are no verified passages", async () => {
    const client = scriptedClient([goodArticle()]);
    const out = await planArticle(QUESTION, [], { client });
    expect(client.calls).toHaveLength(0);
    expect(out.plan).toBeNull();
  });

  it("survives a provider outage without throwing", async () => {
    const client = scriptedClient([new Error("timeout"), new Error("timeout")]);
    const out = await planArticle(QUESTION, PASSAGES, { client });
    expect(out.plan).toBeNull();
    expect(out.source).toBe("deterministic_fallback");
  });

  it("does not send passage text to the planner, only metadata and an opening snippet", async () => {
    const client = scriptedClient([goodArticle()]);
    const seen: string[] = [];
    const configs: Record<string, unknown>[] = [];
    const spy = {
      models: {
        async generateContent(args: Record<string, unknown>) {
          seen.push(String(args.contents ?? ""));
          configs.push((args.config ?? {}) as Record<string, unknown>);
          return { text: goodArticle() };
        },
      },
    };
    await planArticle(QUESTION, PASSAGES, { client: spy });
    void client;
    const prompt = seen[0];
    // The planner is told the ids and a short opening snippet, and explicitly
    // instructed not to quote. It must never receive a full passage body.
    expect(prompt).toContain("verse:1");
    expect(prompt).toMatch(/opening_words/);
    expect(prompt).toMatch(/You do not write, summarise, quote or explain/);
    const config = configs[0];
    expect(config.maxOutputTokens).toBe(ARTICLE_PLANNER_MAX_OUTPUT_TOKENS);
    expect(config.thinkingConfig).toEqual({ thinkingBudget: ARTICLE_PLANNER_THINKING_BUDGET });
  });

  it("skips the model when the list exceeds its schema's capacity — arrangement only, nothing dropped", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...PASSAGES[0],
      passageKey: `verse:${i}`,
    })) as unknown as typeof PASSAGES;
    const client = scriptedClient([goodArticle()]);
    const out = await planArticle(QUESTION, many, { client });
    expect(client.calls).toHaveLength(0);
    expect(out.plan).toBeNull();
    expect(out.source).toBe("deterministic_fallback");
    expect(out.rejections.join(" ")).toMatch(/capacity/);
  });
});
