/**
 * query-plan.ts — ONE schema-constrained query-plan call.
 *
 * Replaces both legacy expansion paths: the ten-variant generator and the
 * long-query preprocessor. Both used raw `JSON.parse` on model output and both
 * were already failing in production with `Unexpected end of JSON input`.
 *
 * What the model is allowed to do here is narrow and structural: classify the
 * intent, restate the question canonically, name terms worth preserving, and
 * propose a small number of search ANGLES with distinct retrieval purposes.
 *
 * What it is not allowed to do is decide anything doctrinal. It never sees a
 * passage, never writes an answer, and its `vocabulary_candidates` are only
 * hints — the server resolves them against `vocab_terms` and discards whatever
 * does not exist. A hallucinated concept cannot become a retrieval filter.
 *
 * Ask for different PURPOSES, not different wording. "the mind as friend and
 * enemy" (scriptural_basis) and "why the mind is restless" (cause) each reach
 * passages the other misses. Ten paraphrases of one sentence reach the same
 * passages ten times and cost ten seconds.
 */
import { z } from "zod";
import { geminiQueryPlannerModel } from "@/app/lib/search-v2/config";
import { extractReference, extractSiglum, siglumOf } from "@/app/lib/search-v2/reference";

/**
 * What the planner may say a question IS. This is a DESCRIPTION, recorded for
 * diagnosis; it selects no branch and changes no budget. Every question gets the
 * same planning call, the same fan-out ceiling and the same reranking.
 */
const INTENTS = [
  "exact_reference",
  "exact_quote",
  "factual_entity",
  "broad_concept",
  "practical_how",
  "why_question",
  "narrative",
  "lecture_specific",
  "letter_specific",
  "comparison",
  "multi_part",
  "insufficient_or_out_of_domain",
] as const;

const SUBQUERY_ROLES = [
  "reformulation",
  "scriptural_basis",
  "definition",
  "cause",
  "method",
  "practice",
  "example",
  "contrast",
  "context",
  "chronology",
  "subquestion",
] as const;

const SOURCE_TYPES = ["verse", "purport", "book", "lecture", "conversation", "letter"] as const;

export const QueryPlanSchema = z
  .object({
    schema_version: z.literal("query-plan-v1"),
    intent: z.enum(INTENTS),
    canonical_query: z.string().min(3).max(240),
    preserve_terms: z.array(z.string().min(1).max(60)).max(10),
    lexical_phrases: z.array(z.string().min(2).max(120)).max(8),
    vocabulary_candidates: z.array(z.string().min(2).max(60)).max(10),
    subqueries: z
      .array(
        z
          .object({
            id: z.string().min(1).max(30),
            text: z.string().min(3).max(160),
            role: z.enum(SUBQUERY_ROLES),
            priority: z.enum(["primary", "supporting", "exploratory"]),
          })
          .strict(),
      )
      .max(6),
    constraints: z
      .object({
        scripture_references: z.array(z.string().max(50)).max(5),
        source_types: z.array(z.enum(SOURCE_TYPES)).max(6),
        speaker: z.string().max(100).nullable(),
        recipient: z.string().max(100).nullable(),
        location: z.string().max(100).nullable(),
        date_from: z.string().nullable(),
        date_to: z.string().nullable(),
      })
      .strict(),
    /**
     * The FULL reference the devotee wrote ("BG 18.66"), when the question is
     * or contains one. This is the retrieval clue that drives the pinned
     * direct_verse_lookup; the siglum alone is what goes into
     * `constraints.scripture_references`, because that is all the `scripture`
     * column stores. Always re-derived server-side from the raw query.
     */
    exact_reference: z.string().max(50).nullable().default(null),
    possible_false_assumption: z.boolean(),
  })
  .strict();

export type QueryPlan = z.infer<typeof QueryPlanSchema>;

/** How the plan was arrived at. Degraded states are reported, never hidden.
 *  There is no retry state: the planner gets one attempt (see PLANNER_TIMEOUT_MS). */
export type PlanSource = "model" | "fallback_original_only";

export interface PlannedQuery {
  plan: QueryPlan;
  source: PlanSource;
  /** Populated when validation rejected something; surfaced in telemetry. */
  rejections: string[];
}

/**
 * The JSON Schema handed to Gemini. Deliberately maintained alongside the Zod
 * schema rather than generated from it: the model needs a description of intent
 * that Zod has no place to carry, and the Zod schema stays the sole authority
 * on what is actually accepted.
 */
export function queryPlanResponseSchema(maxSubqueries: number): Record<string, unknown> {
  return {
    type: "object",
    required: [
      "schema_version",
      "intent",
      "canonical_query",
      "preserve_terms",
      "lexical_phrases",
      "vocabulary_candidates",
      "subqueries",
      "constraints",
      "possible_false_assumption",
    ],
    properties: {
      schema_version: { type: "string", enum: ["query-plan-v1"] },
      intent: { type: "string", enum: [...INTENTS] },
      canonical_query: { type: "string" },
      preserve_terms: { type: "array", maxItems: 10, items: { type: "string" } },
      lexical_phrases: { type: "array", maxItems: 8, items: { type: "string" } },
      vocabulary_candidates: { type: "array", maxItems: 10, items: { type: "string" } },
      subqueries: {
        type: "array",
        maxItems: Math.max(0, maxSubqueries),
        items: {
          type: "object",
          required: ["id", "text", "role", "priority"],
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            role: { type: "string", enum: [...SUBQUERY_ROLES] },
            priority: { type: "string", enum: ["primary", "supporting", "exploratory"] },
          },
        },
      },
      constraints: {
        type: "object",
        required: [
          "scripture_references",
          "source_types",
          "speaker",
          "recipient",
          "location",
          "date_from",
          "date_to",
        ],
        properties: {
          scripture_references: { type: "array", maxItems: 5, items: { type: "string" } },
          source_types: { type: "array", maxItems: 6, items: { type: "string", enum: [...SOURCE_TYPES] } },
          speaker: { type: "string", nullable: true },
          recipient: { type: "string", nullable: true },
          location: { type: "string", nullable: true },
          date_from: { type: "string", nullable: true },
          date_to: { type: "string", nullable: true },
        },
      },
      exact_reference: { type: "string", nullable: true },
      possible_false_assumption: { type: "boolean" },
    },
  };
}

/**
 * The plan used when the model is unavailable or its output cannot be trusted.
 *
 * A scripture reference the devotee wrote is still carried through, because it
 * is a genuine retrieval clue and losing it would make the degraded search worse
 * than it needs to be. The SIGLUM is the constraint handed to the RPCs (the
 * `scripture` column stores "BG", never "BG 18.66"); the full reference rides in
 * `exact_reference` and drives the pinned direct lookup instead.
 */
export function fallbackPlan(query: string): QueryPlan {
  const siglum = extractSiglum(query);
  return {
    schema_version: "query-plan-v1",
    // No router classifies questions any more. The neutral value is what the
    // old router fell through to when nothing narrower matched.
    intent: "broad_concept",
    canonical_query: query.slice(0, 240),
    preserve_terms: [],
    lexical_phrases: [],
    vocabulary_candidates: [],
    subqueries: [],
    constraints: {
      scripture_references: siglum ? [siglum] : [],
      source_types: [],
      speaker: null,
      recipient: null,
      location: null,
      date_from: null,
      date_to: null,
    },
    exact_reference: extractReference(query),
    possible_false_assumption: false,
  };
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Function words carry no retrieval value, so they must not be allowed to make
 * two paraphrases look distinct. "steadying the mind BY practice" and
 * "steadying the mind THROUGH practice" retrieve identical rows; on raw tokens
 * they score 0.71 and slip past any sane threshold, while on content words they
 * are correctly identical.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "into", "onto", "through", "via", "about", "as", "is",
  "are", "was", "were", "be", "been", "being", "do", "does", "did", "can",
  "could", "should", "would", "will", "shall", "may", "might", "must", "that",
  "this", "these", "those", "it", "its", "how", "what", "why", "when", "where",
  "who", "whom", "which", "one", "ones", "s",
]);

/** Content-word Jaccard. Cheap, and adequate for "is this the same question?". */
function jaccard(a: string, b: string): number {
  const tokens = (s: string) => {
    const all = normalise(s).split(" ").filter(Boolean);
    const content = all.filter((t) => !FUNCTION_WORDS.has(t));
    // Fall back to raw tokens rather than comparing two empty sets.
    return new Set(content.length > 0 ? content : all);
  };
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Proper names and scripture sigla that must survive into the plan. */
function significantTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const m of query.matchAll(/\b([A-Z][\p{L}’'-]{2,})\b/gu)) tokens.push(m[1]);
  for (const m of query.matchAll(/\b(?:BG|SB|CC|NOI|ISO|BS|NBS|MMS)\.?\s*\d+(?:[.\s]\d+)*/gi)) {
    tokens.push(m[0]);
  }
  return tokens;
}

export interface SemanticCheckInput {
  query: string;
  plan: QueryPlan;
  /** The fan-out ceiling this plan was asked to respect. */
  maxSubqueries: number;
}

/**
 * Semantic validation — the checks a JSON schema cannot express.
 *
 * Returns the list of reasons the plan is untrustworthy. A non-empty list means
 * the plan is rejected outright, not repaired: a planner that invented a
 * constraint or dropped a name has misread the question, and silently trimming
 * its output hides that.
 */
export function semanticRejections({ query, plan, maxSubqueries }: SemanticCheckInput): string[] {
  const problems: string[] = [];
  const subs = plan.subqueries;

  if (subs.length > maxSubqueries) {
    problems.push(`plan returned ${subs.length} subqueries; the budget permits ${maxSubqueries}`);
  }

  const ids = new Set<string>();
  for (const sq of subs) {
    if (ids.has(sq.id)) problems.push(`duplicate subquery id "${sq.id}"`);
    ids.add(sq.id);
    // A reserved id would collide with the SQL layer's pseudo-queries and
    // silently inherit the original question's weight in fusion.
    if (sq.id === "__lexical__" || sq.id === "__tags__" || sq.id === "q_original") {
      problems.push(`subquery id "${sq.id}" is reserved`);
    }
    if (jaccard(sq.text, query) >= 0.9) {
      problems.push(`subquery "${sq.id}" is equivalent to the original question`);
    }
  }

  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      if (jaccard(subs[i].text, subs[j].text) >= 0.85) {
        problems.push(`subqueries "${subs[i].id}" and "${subs[j].id}" are near-identical`);
      }
    }
  }

  // Names and references present in the question must not vanish from the plan.
  const planText = [plan.canonical_query, ...plan.preserve_terms, ...subs.map((s) => s.text)]
    .join(" ")
    .toLowerCase();
  for (const token of significantTokens(query)) {
    const t = token.toLowerCase();
    if (t.length < 3) continue;
    if (!planText.includes(t.replace(/\s+/g, " "))) {
      problems.push(`plan dropped "${token}" from the original question`);
      break; // one report is enough; the plan is already rejected
    }
  }

  // A constraint the devotee never asked for silently narrows the corpus.
  const q = query.toLowerCase();
  const c = plan.constraints;
  if (c.recipient && !q.includes(c.recipient.toLowerCase().split(/\s+/)[0])) {
    problems.push(`invented recipient constraint "${c.recipient}"`);
  }
  if (c.location && !q.includes(c.location.toLowerCase().split(/\s+/)[0])) {
    problems.push(`invented location constraint "${c.location}"`);
  }
  if (c.speaker && !q.includes(c.speaker.toLowerCase().split(/\s+/)[0])) {
    problems.push(`invented speaker constraint "${c.speaker}"`);
  }
  for (const ref of c.scripture_references) {
    const siglum = ref.trim().split(/[\s.]/)[0]?.toLowerCase();
    if (siglum && siglum.length >= 2 && !q.includes(siglum)) {
      problems.push(`invented scripture constraint "${ref}"`);
      break;
    }
  }
  for (const d of [c.date_from, c.date_to]) {
    if (d && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d)) {
      problems.push(`malformed date constraint "${d}"`);
    }
  }

  // Arbitrary database slugs are the model guessing at internals.
  for (const v of plan.vocabulary_candidates) {
    if (/^[a-z0-9]+(-[a-z0-9]+){3,}$/.test(v) && !q.includes(v.replace(/-/g, " "))) {
      problems.push(`vocabulary candidate "${v}" looks like an invented database slug`);
      break;
    }
  }

  return problems;
}

function buildPrompt(query: string, maxSubqueries: number): string {
  return [
    "You plan a RETRIEVAL STRATEGY over a fixed library of Śrīla Prabhupāda's",
    "books, lectures, conversations and letters. You never answer the question.",
    "",
    "You are producing search angles for a librarian, not a reply for a reader.",
    "",
    `You may return AT MOST ${maxSubqueries} subqueries. Returning more is a failure.`,
    "Returning fewer is fine, and often right: a narrow question needs one or two",
    "angles, and padding it out to the ceiling only retrieves noise.",
    "",
    "Each subquery must serve a DIFFERENT RETRIEVAL PURPOSE — a different role",
    "from the enum, reaching passages the others would miss. Rephrasing the same",
    "sentence is worthless: it retrieves the same rows twice.",
    "",
    "Good, for 'how do I control my mind':",
    '  - "the mind as friend and enemy of the soul"   (scriptural_basis)',
    '  - "why the mind is restless and flickering"     (cause)',
    '  - "practice and detachment to steady the mind"  (method)',
    "Bad: 'how can I control the mind', 'controlling one's mind', 'mind control'.",
    "",
    "RULES",
    "- Preserve every proper name, place, recipient and scripture reference.",
    "- Set a constraint ONLY when the question states it. Never infer one.",
    "- vocabulary_candidates are human-readable CONCEPTS ('devotional service',",
    "  'chanting Hare Krsna'). Never invent database slugs or identifiers.",
    "- lexical_phrases are exact phrases worth matching verbatim, e.g. a quoted",
    "  span. Leave empty if the question quotes nothing.",
    "- possible_false_assumption is true when the question presupposes something",
    "  the corpus may not support.",
    "- Never write doctrine, never answer, never cite.",
    "",
    `Question: ${JSON.stringify(query)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface GenAiLike {
  models: {
    generateContent(args: Record<string, unknown>): Promise<{ text?: string | null }>;
  };
}

/** Injected in tests; the real client is constructed lazily in `planQuery`. */
export interface PlannerDeps {
  client?: GenAiLike;
  timeoutMs?: number;
}

/**
 * 3 s, one attempt, no retry. Every observed production trace showed the
 * planner failing (503 or timeout) and the retry doubling the cost to over
 * eight seconds before retrieval even began. The fallback plan is a perfectly
 * serviceable degraded path; paying twice to avoid it is not.
 */
const PLANNER_TIMEOUT_MS = 3000;

async function callPlanner(
  client: GenAiLike,
  query: string,
  maxSubqueries: number,
  timeoutMs: number,
): Promise<unknown> {
  const response = await withTimeout(
    client.models.generateContent({
      model: geminiQueryPlannerModel(),
      contents: buildPrompt(query, maxSubqueries),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: queryPlanResponseSchema(maxSubqueries),
        temperature: 0.2,
        maxOutputTokens: 1200,
      },
    }),
    timeoutMs,
  );

  const text = response?.text ?? "";
  if (!text.trim()) throw new Error("planner returned an empty body");
  // Structured output means this is JSON, but the parse is still guarded:
  // an unparseable body must degrade, never throw into the request path.
  return JSON.parse(text) as unknown;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`planner timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Produces an approved plan. NEVER throws and never fails into generated
 * doctrine: every failure path lands on the original question alone, which is a
 * worse search but an honest one.
 */
export async function planQuery(
  query: string,
  maxSubqueries: number,
  deps: PlannerDeps = {},
): Promise<PlannedQuery> {
  let client = deps.client;
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      return {
        plan: fallbackPlan(query),
        source: "fallback_original_only",
        rejections: ["GEMINI_API_KEY absent"],
      };
    }
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) as unknown as GenAiLike;
  }

  const timeoutMs = deps.timeoutMs ?? PLANNER_TIMEOUT_MS;
  const rejections: string[] = [];

  // ONE attempt. A retry here doubled the pre-retrieval cost on every planner
  // outage while buying nothing the fallback plan does not already provide.
  try {
    const raw = await callPlanner(client, query, maxSubqueries, timeoutMs);
    const parsed = QueryPlanSchema.safeParse(raw);
    if (!parsed.success) {
      rejections.push(`model: schema — ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    } else {
      const problems = semanticRejections({ query, plan: parsed.data, maxSubqueries });
      if (problems.length > 0) {
        rejections.push(...problems.map((p) => `model: ${p}`));
      } else {
        return { plan: withExtractedReference(query, parsed.data), source: "model", rejections };
      }
    }
  } catch (err) {
    rejections.push(`model: ${err instanceof Error ? err.message : "planner call failed"}`);
  }

  console.warn(
    JSON.stringify({ level: "warn", event: "search.query_plan_degraded", rejections }),
  );
  return { plan: fallbackPlan(query), source: "fallback_original_only", rejections };
}

/**
 * Adds a reference the devotee actually wrote to the approved plan's retrieval
 * constraints, if the planner did not already carry it.
 *
 * Applied AFTER approval, deliberately: `semanticRejections` rejects invented
 * scripture constraints, and a constraint the server derived from the question
 * itself must not be mistaken for one the model made up.
 *
 * Every scripture constraint — the model's included — is reduced to its SIGLUM
 * here, because the `scripture` column stores "BG" and never "BG 18.66": a full
 * reference as a filter matches zero rows and silently deletes every verse.
 * The full reference survives in `exact_reference`, always re-derived from the
 * raw query so the model cannot invent one.
 */
function withExtractedReference(query: string, plan: QueryPlan): QueryPlan {
  const siglum = extractSiglum(query);
  const sigla = [
    ...plan.constraints.scripture_references.map((r) => siglumOf(r)),
    siglum,
  ].filter((s): s is string => Boolean(s));
  return {
    ...plan,
    constraints: {
      ...plan.constraints,
      scripture_references: [...new Set(sigla)].slice(0, 5),
    },
    exact_reference: extractReference(query),
  };
}
