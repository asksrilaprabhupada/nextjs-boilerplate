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
 *
 * FIVE ANGLES ARE REQUIRED, NOT OFFERED. Between 3 and 4 August every one of
 * the 56 production searches planned zero angles: 54 because default Gemini
 * thinking overran the 3 s cap, and 2 that arrived in time and still returned
 * an empty list, because both the prompt and the schema told the model that
 * fewer was fine. Both causes are fixed here — thinking is off, and a plan
 * carrying fewer than {@link REQUIRED_SUBQUERIES} distinct angles is a recorded
 * failure rather than a quiet success.
 */
import { z } from "zod";
import { geminiQueryPlannerModel } from "@/app/lib/search-v2/config";
import {
  extractReference,
  extractSiglum,
  isBareReference,
  siglumOf,
  siglumOfSpelledOutBook,
} from "@/app/lib/search-v2/reference";
import { isPrabhupada } from "@/app/lib/15-transcript-speakers";

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

/**
 * Exactly this many extra search angles, every time. One original question plus
 * five distinct angles is six searches across all five sources — the owner's
 * decision, and the reason "up to six, fewer is fine" is gone from both the
 * prompt and the schema.
 */
export const REQUIRED_SUBQUERIES = 5;

/** Thinking off. Default thinking is what pushed every planner call past 3 s. */
export const QUERY_PLANNER_THINKING_BUDGET = 0;

/**
 * Room for five angles plus the constraint block. Measured at ~450 output
 * tokens for a full plan; the headroom is deliberate, and with thinking at 0
 * none of it is spent on reasoning the way the article planner's was.
 */
export const QUERY_PLANNER_MAX_OUTPUT_TOKENS = 1600;

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
            // Generous on purpose. This is an internal correlation id for
            // fusion weighting, never shown and never stored; a model that
            // emits a descriptive id was failing the WHOLE plan on a limit
            // that protects nothing (3 of 3 runs for one gold question).
            id: z.string().min(1).max(120),
            text: z.string().min(3).max(160),
            role: z.enum(SUBQUERY_ROLES),
            priority: z.enum(["primary", "supporting", "exploratory"]),
          })
          .strict(),
      )
      /**
       * The SHAPE ceiling only. "Exactly five" is asserted in
       * `semanticProblems` instead, so that a short plan is recorded as the
       * specific failure `too_few_angles` rather than as an anonymous schema
       * error — and so `fallbackPlan`, which legitimately carries none, still
       * validates against the shape it must satisfy everywhere else.
       */
      .max(REQUIRED_SUBQUERIES),
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

/** How the plan was arrived at. Degraded states are reported, never hidden. */
export type PlanSource = "model" | "fallback_original_only";

/**
 * WHY the plan fell back — the single most useful field for diagnosing the
 * planner, and the one the database did not have. Until now every failure was
 * stored as the same opaque `plan_rejected`, and the detail that would have
 * separated "Gemini was slow" from "Gemini answered but returned nothing"
 * lived only in Vercel logs that expire.
 */
export type PlanFailureKind =
  /** No GEMINI_API_KEY in the environment. Not a model failure at all. */
  | "api_key_absent"
  /** The call did not return inside PLANNER_TIMEOUT_MS. */
  | "timeout"
  /** The provider rejected or dropped the call (5xx, network, abort). */
  | "provider_error"
  /** A 200 carrying nothing — usually an output-token budget spent on thinking. */
  | "empty_body"
  /** Structured output came back unparseable, normally truncated mid-object. */
  | "invalid_json"
  /** Valid JSON, wrong shape. */
  | "schema_rejected"
  /** Right shape, fewer than REQUIRED_SUBQUERIES angles. */
  | "too_few_angles"
  /** Right count, but the angles repeat each other or the question. */
  | "near_duplicate_angles"
  /** A constraint or name the question never contained: a misreading. */
  | "semantic_rejected"
  /**
   * NOT A FAILURE. The question IS a pointer — a bare scripture reference or a
   * bare quotation — and such a question does not have five distinct retrieval
   * angles to find. "SB 1.2.6" yields "meaning of SB 1.2.6", "purport to
   * SB 1.2.6", "commentary on SB 1.2.6": one search written three ways.
   *
   * Recorded so it can be counted and seen, never as a degradation, because
   * nothing went wrong. The search runs on the question alone — which for a
   * written reference is the best search there is, since `direct_verse_lookup`
   * pins that verse first in the main tier, immune to every cut.
   *
   * Reachable ONLY from `isPointerQuestion`, which reads the question and not
   * the plan. A real question that produces repetitive angles is still a
   * recorded failure: this is a name for a case, not a way out of the rule.
   */
  | "pointer_question";

/**
 * Did the plan fall back because something went WRONG?
 *
 * `pointer_question` is the one outcome that lands on the fallback plan without
 * anything having failed, so it must not raise a degradation, must not warn a
 * devotee, and must not stop a perfectly good answer from being cached.
 */
export function isPlanDegradation(kind: PlanFailureKind | null): boolean {
  return kind !== null && kind !== "pointer_question";
}

/** Provider cost of the planning stage. Recorded so a search has a price. */
export interface PlannerUsage {
  /** 1, or 2 when a repairable plan earned its single retry. */
  attempts: number;
  promptTokens: number;
  outputTokens: number;
  /** Non-zero here would mean thinkingBudget: 0 was not honoured. */
  thoughtsTokens: number;
  totalTokens: number;
  /** Wall-clock across every attempt, including the rejected one. */
  durationMs: number;
  /**
   * One entry per planner call. The 3 s cap applies to a SINGLE call, so a
   * total that happens to span a retry must never be mistaken for the latency
   * the cap is judged against.
   */
  attemptDurationsMs: number[];
}

export interface PlannedQuery {
  plan: QueryPlan;
  source: PlanSource;
  /** Populated when validation rejected something; surfaced in telemetry. */
  rejections: string[];
  /** Null on success. The recorded reason a fallback plan is being used. */
  failureKind: PlanFailureKind | null;
  usage: PlannerUsage;
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
        // Both bounds, deliberately equal: the model is told the count is
        // mandatory in the one place it cannot talk itself out of.
        minItems: Math.max(0, maxSubqueries),
        maxItems: Math.max(0, maxSubqueries),
        description:
          `Exactly ${maxSubqueries} search angles, each with a different role and each reaching passages the others would miss.`,
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

/**
 * A scripture reference is ONE thing, not four words.
 *
 * "SB 1.2.6" tokenises as {sb, 1, 2, 6}, which wrecks every similarity
 * judgement built on top: it clears the four-content-word floor on numerals
 * alone, and two angles that merely both cite the verse share four tokens and
 * read as identical. Collapsing each reference to a single token restores the
 * meaning — "purport to SB 1.2.6" and "lectures on SB 1.2.6" are then two
 * words apart, which is what they are.
 */
const REFERENCE_RE = /\b(?:BG|SB|CC|NOI|ISO|BS|NBS|MMS)\.?\s*\d+(?:[.\s]\d+)*/gi;

function collapseReferences(text: string): string {
  return text.replace(REFERENCE_RE, (match) => ` ref${match.toLowerCase().replace(/[^a-z0-9]/g, "")} `);
}

function normalise(s: string): string {
  return collapseReferences(s)
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

/**
 * Crude suffix stripping, and deliberately crude. Without it "control",
 * "controls" and "controlling" are three different tokens, so "how to control
 * the mind" and "controlling the mind" score 0.33 and sail past any threshold
 * that does not also reject genuinely different angles. It over-stems ("bliss"
 * → "bliss", but "goodness" → "good"); over-stemming can only make two texts
 * look MORE alike, which costs a retry, never a false acceptance.
 */
function stem(token: string): string {
  for (const suffix of ["ations", "ation", "ings", "ing", "edly", "ed", "es", "s"]) {
    if (token.length <= suffix.length + 2 || !token.endsWith(suffix)) continue;
    const root = token.slice(0, -suffix.length);
    // English doubles the final consonant before -ing/-ed: controlling →
    // controll, stopped → stopp. Without collapsing it, "control the mind" and
    // "controlling the mind" stay two different tokens and score 0.5 — under
    // any threshold that also lets five genuinely different angles through.
    return /[bdfglmnprt]{2}$/.test(root) ? root.slice(0, -1) : root;
  }
  return token;
}

/** Content-word Jaccard. Cheap, and adequate for "is this the same question?". */
function jaccard(a: string, b: string): number {
  const tokens = (s: string) => {
    const all = normalise(s).split(" ").filter(Boolean).map(stem);
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

/**
 * Is this question a POINTER?
 *
 * QUESTION IS THE DEFAULT. There are exactly two mechanical escapes, both read
 * off the shape of the input before the planner runs, and neither decided by a
 * model:
 *
 *   1. the input is NOTHING BUT a citation — "BG 18.66", "CC Adi 1.1";
 *   2. the input is a quotation marked as one AND long enough to be a real
 *      quotation rather than a phrase.
 *
 * Everything else falls through to five angles. "control of the mind",
 * "chanting", "love", "krsna consciousness" and "what does BG 18.66 mean about
 * surrender" are all real questions.
 *
 * Nothing here looks for a question mark or a question word. A devotee who
 * omits the punctuation has not thereby stopped asking, and a plain statement
 * is still a question.
 */

/**
 * Roughly eight words. Below this a quoted span is a phrase, not a quotation:
 * "surrender to Krishna" almost certainly appears verbatim somewhere in 244,000
 * passages, and a devotee typing it is asking a question, not citing a line.
 */
export const MIN_QUOTATION_WORDS = 8;

export function isPointerQuestion(query: string): boolean {
  const trimmed = (query || "").trim();
  if (!trimmed) return false;

  // Escape 1 — the whole input is a citation, and nothing else.
  if (isBareReference(trimmed)) return true;

  // Escape 2 — a quotation, marked as one and long enough to be one.
  const quoted = trimmed.match(/^["\u201C\u201D'\u2018\u2019]\s*([\s\S]+?)\s*["\u201C\u201D'\u2018\u2019][\s.,!?]*$/);
  if (quoted) {
    const words = quoted[1].trim().split(/\s+/).filter(Boolean);
    return words.length >= MIN_QUOTATION_WORDS;
  }

  return false;
}

/** How many content words a text carries, after stemming and stop-words. */
function contentTokenCount(text: string): number {
  const all = normalise(text).split(" ").filter(Boolean).map(stem);
  return new Set(all.filter((t) => !FUNCTION_WORDS.has(t))).size;
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
  /** The fan-out size this plan was asked to hit exactly. */
  maxSubqueries: number;
}

/**
 * How alike two angles may be before they stop being two angles.
 *
 * Content-word Jaccard after stemming. Five angles on one subject share the
 * subject word by construction ("the mind" appears in all of them), so a
 * genuinely distinct set scores around 0.1–0.25 on this measure; the old 0.85
 * pair threshold was loose enough that only near-copies tripped it. These are
 * starting values, tightened once and to be moved only from measured
 * acceptance rates, never from a guess.
 */
export const NEAR_DUPLICATE_OF_ORIGINAL = 0.8;
export const NEAR_DUPLICATE_PAIR = 0.7;

/** A rejection, and whether a second attempt could plausibly repair it. */
export interface PlanProblem {
  kind: PlanFailureKind;
  message: string;
  /**
   * True for a plan the model simply built carelessly — too few angles,
   * repeated angles, repeated roles. False for a MISREADING (an invented
   * constraint, a dropped name): asking the same model to re-read the same
   * question is not a repair, it is a second chance at the same mistake.
   */
  repairable: boolean;
}

/**
 * Semantic validation — the checks a JSON schema cannot express.
 *
 * A non-empty list means the plan is rejected, never trimmed into shape.
 * Repairable problems earn exactly one retry (see `planQuery`); everything else
 * lands on the honest fallback immediately.
 */
export function semanticProblems({ query, plan, maxSubqueries }: SemanticCheckInput): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const subs = plan.subqueries;
  const push = (kind: PlanFailureKind, message: string, repairable: boolean): void => {
    problems.push({ kind, message, repairable });
  };

  // EXACTLY this many. "Fewer is fine" is what produced 56 zero-angle searches.
  if (subs.length !== maxSubqueries) {
    push(
      subs.length < maxSubqueries ? "too_few_angles" : "semantic_rejected",
      `plan returned ${subs.length} subqueries; exactly ${maxSubqueries} are required`,
      subs.length < maxSubqueries,
    );
  }

  /**
   * "Is this angle just the question again?" only means something when the
   * question has enough content words to overlap on. "SB 1.2.6" has three
   * tokens, so "purport to SB 1.2.6" scores 0.75 against it and reads as a
   * duplicate — while actually reaching a different table. Below this floor,
   * distinctness is judged between the angles alone.
   */
  const queryIsSubstantial = contentTokenCount(query) >= 4;

  const ids = new Set<string>();
  for (const sq of subs) {
    if (ids.has(sq.id)) push("semantic_rejected", `duplicate subquery id "${sq.id}"`, false);
    ids.add(sq.id);
    // A reserved id would collide with the SQL layer's pseudo-queries and
    // silently inherit the original question's weight in fusion.
    if (sq.id === "__lexical__" || sq.id === "__tags__" || sq.id === "q_original") {
      push("semantic_rejected", `subquery id "${sq.id}" is reserved`, false);
    }
    if (queryIsSubstantial && jaccard(sq.text, query) >= NEAR_DUPLICATE_OF_ORIGINAL) {
      push(
        "near_duplicate_angles",
        `subquery "${sq.id}" is equivalent to the original question`,
        true,
      );
    }
  }

  // A REPEATED ROLE IS NOT A REPEATED ANGLE. This was rejected here until the
  // gate showed what it was throwing away: "Compare karma-yoga and bhakti-yoga"
  // wants two `definition` angles, one per thing being compared, and they
  // retrieve entirely different passages. Twenty-two of the gate's rejections
  // were plans exactly like that. Role diversity stays in the prompt as
  // guidance; distinctness is judged on the TEXT below, which is the thing that
  // actually decides whether two angles reach the same rows.
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      if (jaccard(subs[i].text, subs[j].text) >= NEAR_DUPLICATE_PAIR) {
        push(
          "near_duplicate_angles",
          `subqueries "${subs[i].id}" and "${subs[j].id}" are near-identical`,
          true,
        );
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
      push("semantic_rejected", `plan dropped "${token}" from the original question`, false);
      break; // one report is enough; the plan is already rejected
    }
  }

  // A constraint the devotee never asked for silently narrows the corpus.
  const q = query.toLowerCase();
  const c = plan.constraints;
  if (c.recipient && !q.includes(c.recipient.toLowerCase().split(/\s+/)[0])) {
    push("semantic_rejected", `invented recipient constraint "${c.recipient}"`, false);
  }
  if (c.location && !q.includes(c.location.toLowerCase().split(/\s+/)[0])) {
    push("semantic_rejected", `invented location constraint "${c.location}"`, false);
  }
  // Naming Śrīla Prabhupāda is not an invention and narrows nothing — the whole
  // library is his. "In a morning walk, what did HE say about scientists?"
  // resolves to him correctly, and rejecting that cost fifteen good plans in the
  // gate. A guest the question never mentioned is still a misreading.
  if (
    c.speaker
    && !isPrabhupada(c.speaker)
    && !q.includes(c.speaker.toLowerCase().split(/\s+/)[0])
  ) {
    push("semantic_rejected", `invented speaker constraint "${c.speaker}"`, false);
  }
  // Compare SIGLA, not raw text. "Bhagavad-gita 6.6" contains no "bg", so the
  // correct constraint "Bg 6.6" read as invented and threw the plan away.
  const querySiglum = extractSiglum(query) ?? siglumOfSpelledOutBook(query);
  for (const ref of c.scripture_references) {
    const planSiglum = siglumOf(ref);
    if (!planSiglum) continue;
    if (querySiglum && planSiglum === querySiglum) continue;
    if (!q.includes(planSiglum.toLowerCase())) {
      push("semantic_rejected", `invented scripture constraint "${ref}"`, false);
      break;
    }
  }
  for (const d of [c.date_from, c.date_to]) {
    if (d && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d)) {
      push("semantic_rejected", `malformed date constraint "${d}"`, false);
    }
  }

  // Arbitrary database slugs are the model guessing at internals.
  for (const v of plan.vocabulary_candidates) {
    if (/^[a-z0-9]+(-[a-z0-9]+){3,}$/.test(v) && !q.includes(v.replace(/-/g, " "))) {
      push(
        "semantic_rejected",
        `vocabulary candidate "${v}" looks like an invented database slug`,
        false,
      );
      break;
    }
  }

  return problems;
}

/** Message-only view, for callers and tests that only need the reasons. */
export function semanticRejections(input: SemanticCheckInput): string[] {
  return semanticProblems(input).map((problem) => problem.message);
}

function buildPrompt(query: string, maxSubqueries: number, repairNotes: string[] = []): string {
  return [
    "You plan a RETRIEVAL STRATEGY over a fixed library of Śrīla Prabhupāda's",
    "books, lectures, conversations and letters. You never answer the question.",
    "",
    "You are producing search angles for a librarian, not a reply for a reader.",
    "",
    `Return EXACTLY ${maxSubqueries} subqueries. Not fewer, not more. A shorter`,
    "list is a failed plan and is thrown away — even for a narrow question, even",
    "for a bare scripture reference, even when the question looks fully covered",
    `by itself. The library is searched with the original question PLUS your ${maxSubqueries}`,
    `angles, so ${maxSubqueries + 1} searches run and their results are merged.`,
    "",
    "Each subquery must serve a DIFFERENT RETRIEVAL PURPOSE, reaching passages",
    "the others would miss. Prefer a different `role` for each, but two angles",
    "may share a role when they genuinely differ — comparing two things means",
    "defining both. Rephrasing the same sentence is worthless: it retrieves the",
    "same rows twice and wastes one of your five angles.",
    "",
    "Worked example — 'how do I control my mind' (the original question is",
    "searched too, so do not restate it):",
    '  1. "why the mind becomes restless and uncontrolled"      (cause)',
    '  2. "what the scriptures teach about the nature of the mind" (scriptural_basis)',
    '  3. "practice and detachment as the method of control"    (method)',
    '  4. "obstacles a practitioner meets in steadying the mind" (practice)',
    '  5. "analogies and examples for the wandering mind"       (example)',
    "Bad: 'how can I control the mind', 'controlling one's mind', 'mind control'",
    "— three rewordings of one angle.",
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
    // The retry is told what was wrong with the first plan. A blind second
    // attempt at the same prompt tends to reproduce the same mistake.
    ...(repairNotes.length > 0
      ? [
          "YOUR PREVIOUS PLAN WAS REJECTED:",
          ...repairNotes.map((note) => `  - ${note}`),
          `Return ${maxSubqueries} angles that are clearly different from one another,`,
          "each with its own role. Do not repeat the wording of the question.",
          "",
        ]
      : []),
    `Question: ${JSON.stringify(query)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The token accounting Gemini returns beside the body. All fields optional. */
interface GenAiUsage {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
  totalTokenCount?: number | null;
}

interface GenAiLike {
  models: {
    generateContent(
      args: Record<string, unknown>,
    ): Promise<{ text?: string | null; usageMetadata?: GenAiUsage | null }>;
  };
}

/**
 * Evaluator-private accounting at the provider-call boundary.
 *
 * This deliberately carries only numeric usage metadata. It is never attached
 * to `PlannerUsage` or `PlannedQuery`, so normal telemetry and public output
 * retain their existing shape.
 */
export interface PrivatePlannerCallUsage {
  readonly attempt: number;
  readonly responseReceived: boolean;
  readonly promptTokenCount: number | null;
  readonly candidatesTokenCount: number | null;
  readonly thoughtsTokenCount: number | null;
  readonly toolUsePromptTokenCount: number | null;
  readonly totalTokenCount: number | null;
}

export type PrivatePlannerCallUsageObserver = (
  event: PrivatePlannerCallUsage,
) => void | Promise<void>;

/** Injected in tests; the real client is constructed lazily in `planQuery`. */
export interface PlannerDeps {
  client?: GenAiLike;
  timeoutMs?: number;
  /** Test seam for deterministic durations. */
  now?: () => number;
  /** Evaluator-only call accounting; observer failures never affect search. */
  privateCallUsageObserver?: PrivatePlannerCallUsageObserver;
}

/**
 * 4 s PER ATTEMPT — measured, not guessed.
 *
 * It stayed at 3 s until measurement said otherwise, which is the only reason
 * it moved. Over 206 single planner calls against the gold set, run serially
 * so the number means what it says:
 *
 *   fastest 537 ms · median 2,273 ms · p95 2,999.96 ms · slowest 3,003 ms
 *
 * That p95 sitting a fraction under 3,000 ms is not a comfortable fit — it is
 * the distribution being CLIPPED by the old cap. Everything slower was
 * truncated into a timeout, 16 of them in that run, so the true p95 is at
 * least 3 s and unknowable from behind the cap. Measured p95 plus one second
 * gives 4,000 ms.
 *
 * Thinking is still off; this is the residual tail of a loaded provider, not
 * deliberation. Planning may now take up to 8 s when a repairable plan earns
 * its retry, against a 300 s request budget and ~25 s of cold retrieval.
 */
const PLANNER_TIMEOUT_MS = 4000;

/** Distinguishes "took too long" from "came back wrong" at the call boundary. */
class PlannerCallError extends Error {
  constructor(readonly kind: PlanFailureKind, message: string) {
    super(message);
    this.name = "PlannerCallError";
  }
}

interface PlannerCallResult {
  text: string;
  usage: GenAiUsage;
}

async function callPlanner(
  client: GenAiLike,
  query: string,
  maxSubqueries: number,
  timeoutMs: number,
  repairNotes: string[],
  attempt: number,
  privateCallUsageObserver?: PrivatePlannerCallUsageObserver,
): Promise<PlannerCallResult> {
  let responseReceived = false;
  let usage: GenAiUsage = {};
  let text = "";
  try {
    const response = await withTimeout(
      client.models.generateContent({
        model: geminiQueryPlannerModel(),
        contents: buildPrompt(query, maxSubqueries, repairNotes),
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: queryPlanResponseSchema(maxSubqueries),
          temperature: 0.2,
          // Thinking OFF. Default thinking is what put every 2026-08 planner
          // call past the 3 s cap, and it is the same failure that truncated
          // the article planner's output when it spent 1,340 of 1,400 tokens
          // reasoning. A retrieval plan is a structural task; it does not need
          // deliberation, it needs to arrive.
          thinkingConfig: { thinkingBudget: QUERY_PLANNER_THINKING_BUDGET },
          maxOutputTokens: QUERY_PLANNER_MAX_OUTPUT_TOKENS,
        },
      }),
      timeoutMs,
    );
    responseReceived = true;
    // Capture accounting before body validation. Empty or malformed bodies are
    // still paid responses, even though the normal planner will reject them.
    usage = response?.usageMetadata ?? {};
    text = response?.text ?? "";
  } catch (err) {
    if (err instanceof PlannerCallError) throw err;
    throw new PlannerCallError(
      "provider_error",
      err instanceof Error ? err.message : "planner call failed",
    );
  } finally {
    if (privateCallUsageObserver) {
      try {
        const observed = privateCallUsageObserver({
          attempt,
          responseReceived,
          promptTokenCount: usage.promptTokenCount ?? null,
          candidatesTokenCount: usage.candidatesTokenCount ?? null,
          thoughtsTokenCount: usage.thoughtsTokenCount ?? null,
          toolUsePromptTokenCount: usage.toolUsePromptTokenCount ?? null,
          totalTokenCount: usage.totalTokenCount ?? null,
        });
        if (observed) {
          // Evaluator persistence may be asynchronous, but search must neither
          // wait for it nor surface a later rejected bookkeeping promise.
          void Promise.resolve(observed).catch(() => undefined);
        }
      } catch {
        // Evaluator bookkeeping is fail-closed in the evaluator itself; it must
        // never change a devotee's search result or the planner's fallback.
      }
    }
  }

  return { text, usage };
}

function parsePlannerBody(text: string): unknown {
  if (!text.trim()) throw new PlannerCallError("empty_body", "planner returned an empty body");
  try {
    // Structured output means this is JSON, but the parse is still guarded:
    // an unparseable body must degrade, never throw into the request path.
    return JSON.parse(text) as unknown;
  } catch {
    throw new PlannerCallError("invalid_json", "planner body was not parseable JSON");
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PlannerCallError("timeout", `planner timed out after ${ms}ms`)),
      ms,
    );
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
  const now = deps.now ?? (() => globalThis.performance.now());
  const startedAt = now();
  const usage: PlannerUsage = {
    attempts: 0,
    promptTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    attemptDurationsMs: [],
  };
  const finish = (
    plan: QueryPlan,
    source: PlanSource,
    rejections: string[],
    failureKind: PlanFailureKind | null,
  ): PlannedQuery => {
    usage.durationMs = Math.round(Math.max(0, now() - startedAt) * 1000) / 1000;
    if (failureKind !== null) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "search.query_plan_degraded",
          failureKind,
          attempts: usage.attempts,
          durationMs: usage.durationMs,
          rejections,
        }),
      );
    }
    return { plan, source, rejections, failureKind, usage };
  };

  let client = deps.client;
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      return finish(
        fallbackPlan(query),
        "fallback_original_only",
        ["GEMINI_API_KEY absent"],
        "api_key_absent",
      );
    }
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) as unknown as GenAiLike;
  }

  const timeoutMs = deps.timeoutMs ?? PLANNER_TIMEOUT_MS;
  const rejections: string[] = [];
  let failureKind: PlanFailureKind = "provider_error";
  let repairNotes: string[] = [];

  // AT MOST TWO attempts, and the second one only happens for a plan the model
  // could plainly do better on: too few angles, or angles that repeat one
  // another. A timeout, an outage or a misread question do not earn a retry —
  // paying twice for the same answer is what the single-attempt rule was
  // protecting against, and the fallback plan is still an honest search.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    usage.attempts = attempt;
    const attemptStartedAt = now();
    const recordAttempt = (): void => {
      usage.attemptDurationsMs.push(
        Math.round(Math.max(0, now() - attemptStartedAt) * 1000) / 1000,
      );
    };
    try {
      const called = await callPlanner(
        client,
        query,
        maxSubqueries,
        timeoutMs,
        repairNotes,
        attempt,
        deps.privateCallUsageObserver,
      );
      const raw = parsePlannerBody(called.text);
      recordAttempt();
      usage.promptTokens += called.usage.promptTokenCount ?? 0;
      usage.outputTokens += called.usage.candidatesTokenCount ?? 0;
      usage.thoughtsTokens += called.usage.thoughtsTokenCount ?? 0;
      usage.totalTokens += called.usage.totalTokenCount ?? 0;

      const parsed = QueryPlanSchema.safeParse(raw);
      if (!parsed.success) {
        failureKind = "schema_rejected";
        rejections.push(
          `model: schema — ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`,
        );
        break;
      }

      const problems = semanticProblems({ query, plan: parsed.data, maxSubqueries });
      if (problems.length === 0) {
        return finish(withExtractedReference(query, parsed.data), "model", rejections, null);
      }
      rejections.push(...problems.map((p) => `model: ${p.message}`));
      // The kind reported is the FIRST problem's, so "too few angles" is not
      // buried under the duplicate reports it inevitably drags with it.
      failureKind = problems[0].kind;
      const repairable = problems.every((p) => p.repairable);
      if (!repairable || attempt === 2) {
        // A POINTER question that could not be given five distinct angles is
        // not a failure — it is a question with only one angle in it. The test
        // reads the QUESTION, never the plan, so a real question cannot reach
        // this even when its angles come back repetitive: it still owes five.
        if (
          problems.every((p) => p.kind === "near_duplicate_angles")
          && isPointerQuestion(query)
        ) {
          failureKind = "pointer_question";
        }
        break;
      }
      repairNotes = problems.map((p) => p.message);
    } catch (err) {
      recordAttempt();
      failureKind = err instanceof PlannerCallError ? err.kind : "provider_error";
      rejections.push(`model: ${err instanceof Error ? err.message : "planner call failed"}`);
      break;
    }
  }

  return finish(fallbackPlan(query), "fallback_original_only", rejections, failureKind);
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
