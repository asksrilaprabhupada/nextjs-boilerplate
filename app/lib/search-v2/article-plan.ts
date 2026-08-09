/**
 * article-plan.ts — Gemini returns STRUCTURE ONLY.
 *
 * The planner receives the original question, the approved passage IDs, limited
 * verified metadata, and the closed list of structural roles it may choose from.
 * It receives no permission to quote, paraphrase, or write a heading.
 *
 * It may: choose an article type, order passages, group them into sections, pick
 * a `heading_key` from an enum and a short neutral subject, and choose a
 * transition type from an enum.
 *
 * It may not: write the doctrinal answer, produce or shorten a quotation, invent
 * a citation, reconcile apparently conflicting teachings, turn a
 * recipient-specific letter into a universal instruction, or write theological
 * connective prose. Headings are assembled server-side from `heading_key` plus
 * `short_subject`; transitions come from a fixed table. Everything a devotee
 * reads as teaching comes from a re-fetched source row.
 *
 * The disclosure string is a literal in the schema, so a plan that alters it
 * fails validation rather than quietly changing what the page claims about
 * itself.
 */
import { z } from "zod";
import { geminiArticlePlannerModel } from "@/app/lib/search-v2/config";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";

export const DISCLOSURE =
  "The organisation was assisted by AI. All teachings displayed are taken from the cited source passages." as const;

const ARTICLE_TYPES = [
  "direct_answer",
  "guided_study",
  "scripture_and_commentary",
  "source_comparison",
  "chronological_development",
  "lecture_focused",
  "letter_focused",
  "evidence_insufficient",
] as const;

const HEADING_KEYS = [
  "foundation",
  "definition",
  "explanation",
  "cause",
  "practice",
  "example",
  "qualification",
  "contrast",
  "historical_context",
  "further_evidence",
] as const;

const TRANSITION_TYPES = [
  "none",
  "deepening",
  "source_shift",
  "chronology",
  "practice",
  "contrast",
  "qualification",
] as const;

export const ArticlePlanSchema = z
  .object({
    schema_version: z.literal("article-plan-v1"),
    article_type: z.enum(ARTICLE_TYPES),
    title: z.string().min(3).max(90),
    opening: z
      .object({
        kind: z.enum(["direct_source", "neutral_source_map"]),
        passage_id: z.string().nullable(),
      })
      .strict(),
    direct_answer_passage_ids: z.array(z.string()).max(3),
    sections: z
      .array(
        z
          .object({
            heading_key: z.enum(HEADING_KEYS),
            short_subject: z.string().min(0).max(50),
            passage_ids: z.array(z.string()).min(1).max(4),
            transition_type: z.enum(TRANSITION_TYPES),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    closing: z
      .object({
        kind: z.enum(["none", "final_source", "further_study"]),
        passage_ids: z.array(z.string()).max(3),
      })
      .strict(),
    disclosure: z.literal(DISCLOSURE),
  })
  .strict();

export type ArticlePlan = z.infer<typeof ArticlePlanSchema>;

export type ArticlePlanSource = "model" | "model_retry" | "deterministic_fallback";

export interface PlannedArticle {
  plan: ArticlePlan | null;
  source: ArticlePlanSource;
  rejections: string[];
}

/**
 * Words that would make a title or subject a doctrinal claim rather than a
 * label, plus the devotional-clickbait register the brief rules out.
 */
const UNSUPPORTED_CLAIM_RE =
  /\b(secret|ancient formula|will transform|proves?|proof that|truth about|shocking|amazing|must know|guaranteed|the only way|never fails|instantly|miracle|unlock|revealed)\b/i;

const URGENCY_RE = /\b(now|today|before it'?s too late|don'?t miss|act now|hurry)\b/i;

export interface ArticleValidationInput {
  plan: ArticlePlan;
  /** Exactly the passages that were supplied to the planner, post re-fetch. */
  passages: VerifiedPassage[];
  question: string;
}

/**
 * Semantic validation. Returns reasons the plan must not be used.
 *
 * As with the query plan, problems are grounds for rejection rather than
 * repair: a planner referencing an id it was never given, or dressing an
 * evidence-insufficient result as a confident answer, has misunderstood its job.
 */
export function articleRejections({
  plan,
  passages,
}: ArticleValidationInput): string[] {
  const problems: string[] = [];
  const supplied = new Set(passages.map((p) => p.passageKey));
  const byKey = new Map(passages.map((p) => [p.passageKey, p]));

  const referenced: string[] = [
    ...(plan.opening.passage_id ? [plan.opening.passage_id] : []),
    ...plan.direct_answer_passage_ids,
    ...plan.sections.flatMap((s) => s.passage_ids),
    ...plan.closing.passage_ids,
  ];

  // 1. Every id must be one we supplied. This is the invented-citation guard.
  for (const id of referenced) {
    if (!supplied.has(id)) {
      problems.push(`plan references passage_id "${id}" that was never supplied`);
    }
  }

  // 2. More distinct passages than were supplied means invented or duplicated
  //    ids. There is no display ceiling any more — whatever the plan does not
  //    place, the renderer appends afterwards, so nothing is ever dropped.
  const distinct = new Set(referenced);
  if (distinct.size > passages.length) {
    problems.push(`plan uses ${distinct.size} passages; only ${passages.length} were supplied`);
  }

  // 3. A section with no passages is a section of pure AI prose.
  for (const [i, s] of plan.sections.entries()) {
    if (s.passage_ids.length === 0) problems.push(`section ${i} has no passages`);
  }

  // 4. Repetition without a structural reason. A passage may legitimately appear
  //    as both the opening and inside its section; beyond that it is padding.
  const counts = new Map<string, number>();
  for (const id of plan.sections.flatMap((s) => s.passage_ids)) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) problems.push(`passage "${id}" repeats across sections without a structural reason`);
  }

  // 5. A letter must keep its context. If a letter is used, the renderer will
  //    label it — but a plan that puts a letter in a section whose heading
  //    frames it as general teaching is rejected here.
  for (const id of referenced) {
    const p = byKey.get(id);
    if (p?.sourceType === "letter" && (!p.recipient || !p.date)) {
      problems.push(`letter "${id}" lacks verified recipient/date and cannot be shown`);
    }
  }

  // 6. Chronology claimed without dates.
  if (plan.article_type === "chronological_development") {
    const dated = referenced.map((id) => byKey.get(id)).filter((p) => p?.date);
    if (dated.length < 2) {
      problems.push("chronological_development claimed but fewer than two passages carry dates");
    }
  }

  // 7. An evidence-insufficient result dressed as a confident answer.
  if (plan.article_type === "evidence_insufficient" && plan.direct_answer_passage_ids.length > 0) {
    problems.push("evidence_insufficient plan asserts a direct answer");
  }
  if (passages.length === 0 && plan.article_type !== "evidence_insufficient") {
    problems.push("no passages available but plan is not evidence_insufficient");
  }

  // 8. Titles and subjects must be honest labels, not claims or clickbait.
  if (UNSUPPORTED_CLAIM_RE.test(plan.title) || URGENCY_RE.test(plan.title)) {
    problems.push(`title makes an unsupported or promotional claim: "${plan.title}"`);
  }
  for (const s of plan.sections) {
    if (UNSUPPORTED_CLAIM_RE.test(s.short_subject)) {
      problems.push(`section subject makes an unsupported claim: "${s.short_subject}"`);
    }
  }

  // 9. A plan trying to supply prose. `short_subject` is a label; a sentence is
  //    an attempt to write connective theology through the schema.
  for (const s of plan.sections) {
    if (/[.!?]\s|\b(is|are|was|were|means|teaches|shows|proves)\b/i.test(s.short_subject)) {
      problems.push(`section subject "${s.short_subject}" reads as prose, not a label`);
    }
  }

  // 10. An opening claiming a direct source must name one.
  if (plan.opening.kind === "direct_source" && !plan.opening.passage_id) {
    problems.push("opening claims a direct source but names no passage");
  }

  return problems;
}

/**
 * The most passages a plan can physically place: 5 sections × 4 ids, plus the
 * closing's 3. Beyond this the planner is skipped rather than asked to do the
 * impossible — the deterministic renderer takes over, and NOTHING is dropped
 * either way: unplaced passages are always appended after the sections.
 */
export const ARTICLE_PLANNER_CAPACITY = 23;
export const ARTICLE_PLANNER_THINKING_BUDGET = 0;
export const ARTICLE_PLANNER_MAX_OUTPUT_TOKENS = 4096;

/** JSON Schema handed to Gemini, mirroring the Zod schema. */
export function articlePlanResponseSchema(maxPassages: number): Record<string, unknown> {
  return {
    type: "object",
    required: [
      "schema_version",
      "article_type",
      "title",
      "opening",
      "direct_answer_passage_ids",
      "sections",
      "closing",
      "disclosure",
    ],
    properties: {
      schema_version: { type: "string", enum: ["article-plan-v1"] },
      article_type: { type: "string", enum: [...ARTICLE_TYPES] },
      title: { type: "string" },
      opening: {
        type: "object",
        required: ["kind", "passage_id"],
        properties: {
          kind: { type: "string", enum: ["direct_source", "neutral_source_map"] },
          passage_id: { type: "string", nullable: true },
        },
      },
      direct_answer_passage_ids: { type: "array", maxItems: 3, items: { type: "string" } },
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          required: ["heading_key", "short_subject", "passage_ids", "transition_type"],
          properties: {
            heading_key: { type: "string", enum: [...HEADING_KEYS] },
            short_subject: { type: "string" },
            passage_ids: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
            transition_type: { type: "string", enum: [...TRANSITION_TYPES] },
          },
        },
      },
      closing: {
        type: "object",
        required: ["kind", "passage_ids"],
        properties: {
          kind: { type: "string", enum: ["none", "final_source", "further_study"] },
          passage_ids: { type: "array", maxItems: Math.min(3, maxPassages), items: { type: "string" } },
        },
      },
      disclosure: { type: "string", enum: [DISCLOSURE] },
    },
  };
}

function buildPrompt(question: string, passages: VerifiedPassage[]): string {
  // Only limited, verified metadata. Deliberately NOT the full passage text:
  // the planner has no business reading the teaching in order to arrange it,
  // and a shorter context is a smaller surface for it to start paraphrasing.
  const inventory = passages
    .map((p) => {
      const bits = [`passage_id: ${p.passageKey}`, `source_type: ${p.sourceType}`];
      if (p.reference) bits.push(`reference: ${p.reference}`);
      if (p.date) bits.push(`date: ${p.date}`);
      if (p.recipient) bits.push(`recipient: ${p.recipient}`);
      if (p.location) bits.push(`location: ${p.location}`);
      bits.push(`opening_words: ${JSON.stringify((p.text || "").slice(0, 120))}`);
      return "- " + bits.join("\n  ");
    })
    .join("\n");

  return [
    "You ORGANISE source passages. You do not write, summarise, quote or explain them.",
    "",
    "Every word a reader sees as teaching comes from the passages themselves,",
    "rendered by a deterministic template from a fresh database read. Your output",
    "is structure: which passage goes where, in what order, under which heading",
    "key, with which transition type.",
    "",
    "You must not:",
    "  - write or shorten a quotation, or restate what a passage says",
    "  - invent a passage_id, a citation, a date, a recipient or a place",
    "  - reconcile passages that appear to disagree",
    "  - present a letter to one person as a universal instruction",
    "  - write a spiritual conclusion or a take-home message",
    "",
    "`title` is an honest label for what the sources cover. Good: \"Controlling",
    "the Mind: Practice, Detachment and Remembrance of Kṛṣṇa\". Not: \"The Secret",
    "Ancient Formula That Will Transform Your Mind Forever\". No clickbait, no",
    "urgency, no claim the passages do not support.",
    "",
    "`short_subject` is a NOUN LABEL of at most a few words, not a sentence.",
    "",
    `${passages.length} passages are available. Arrange the ones that structure`,
    "the answer best — anything you do not place is still shown after your",
    "sections, in relevance order. Nothing is dropped by leaving it unplaced.",
    "",
    "If the passages do not answer the question, use article_type",
    "\"evidence_insufficient\" and leave direct_answer_passage_ids empty.",
    "",
    `Question: ${JSON.stringify(question)}`,
    "",
    "Available passages:",
    inventory || "(none)",
  ].join("\n");
}

interface GenAiLike {
  models: { generateContent(args: Record<string, unknown>): Promise<{ text?: string | null }> };
}

export interface ArticlePlannerDeps {
  client?: GenAiLike;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`article planner timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Produces an approved article plan, or null.
 *
 * Null is not a failure to handle later — it is the instruction to use the
 * deterministic renderer's own ordering, which needs no model at all.
 */
export async function planArticle(
  question: string,
  passages: VerifiedPassage[],
  deps: ArticlePlannerDeps = {},
): Promise<PlannedArticle> {
  if (passages.length === 0) {
    return { plan: null, source: "deterministic_fallback", rejections: ["no verified passages"] };
  }

  // The list is too long for the plan schema to place. Falling back to the
  // deterministic renderer changes ARRANGEMENT only — every passage is shown
  // either way, in relevance order.
  if (passages.length > ARTICLE_PLANNER_CAPACITY) {
    return {
      plan: null,
      source: "deterministic_fallback",
      rejections: [`${passages.length} passages exceed the planner's capacity of ${ARTICLE_PLANNER_CAPACITY}`],
    };
  }

  let client = deps.client;
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      return { plan: null, source: "deterministic_fallback", rejections: ["GEMINI_API_KEY absent"] };
    }
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) as unknown as GenAiLike;
  }

  const timeoutMs = deps.timeoutMs ?? 5000;
  const rejections: string[] = [];

  for (const attempt of ["model", "model_retry"] as const) {
    try {
      const res = await withTimeout(
        client.models.generateContent({
          model: geminiArticlePlannerModel(),
          contents: buildPrompt(question, passages),
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: articlePlanResponseSchema(passages.length),
            temperature: 0.1,
            thinkingConfig: { thinkingBudget: ARTICLE_PLANNER_THINKING_BUDGET },
            maxOutputTokens: ARTICLE_PLANNER_MAX_OUTPUT_TOKENS,
          },
        }),
        timeoutMs,
      );

      const text = res?.text ?? "";
      if (!text.trim()) throw new Error("empty planner body");

      const parsed = ArticlePlanSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        rejections.push(`${attempt}: schema — ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
        continue;
      }

      const problems = articleRejections({
        plan: parsed.data,
        passages,
        question,
      });
      if (problems.length > 0) {
        rejections.push(...problems.map((p) => `${attempt}: ${p}`));
        continue;
      }

      return { plan: parsed.data, source: attempt, rejections };
    } catch (err) {
      rejections.push(`${attempt}: ${err instanceof Error ? err.message : "call failed"}`);
    }
  }

  console.warn(
    JSON.stringify({ level: "warn", event: "search.article_plan_degraded", rejections }),
  );
  return { plan: null, source: "deterministic_fallback", rejections };
}
