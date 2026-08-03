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
import { planQuery, fallbackPlan } from "@/app/lib/search-v2/query-plan";
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
  return {
    calls,
    models: {
      async generateContent(args: Record<string, unknown>) {
        calls.push(String(args.model ?? ""));
        const next = bodies.shift();
        if (next instanceof Error) throw next;
        return { text: next ?? "" };
      },
    },
  };
}

const QUESTION = "how do I control my restless mind";
/** The one fan-out ceiling. Every question is planned against it. */
const MAX_SUBQUERIES = 6;

function goodPlan(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: "query-plan-v1",
    intent: "practical_how",
    canonical_query: "how to control the restless mind",
    preserve_terms: ["mind"],
    lexical_phrases: [],
    vocabulary_candidates: ["the mind"],
    subqueries: [
      { id: "s1", text: "the mind as friend and enemy of the soul", role: "scriptural_basis", priority: "primary" },
      { id: "s2", text: "why the mind is restless and flickering", role: "cause", priority: "supporting" },
    ],
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
    expect(out.plan.subqueries).toHaveLength(2);
    expect(client.calls).toHaveLength(1);
  });

  it("does NOT retry a truncated body — one attempt, then the honest fallback", async () => {
    // A retry doubled the pre-retrieval cost on every planner outage while
    // buying nothing the fallback plan does not already provide.
    const client = scriptedClient(['{"schema_version":"query-pl', goodPlan()]);
    const out = await planQuery(QUESTION, MAX_SUBQUERIES, { client });
    expect(out.source).toBe("fallback_original_only");
    expect(client.calls).toHaveLength(1);
    expect(out.rejections.length).toBeGreaterThan(0);
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
        subqueries: [],
      }),
    ]);
    const out = await planQuery("BG 18.66", MAX_SUBQUERIES, { client });
    expect(client.calls).toHaveLength(1);
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
