/**
 * intent.ts — Deterministic intent and exact-reference routing.
 *
 * Cheap recognition BEFORE any model call. Two jobs:
 *
 *   1. Decide what kind of question this is, so the pipeline can size itself.
 *   2. Catch the cases that need no model at all — an exact scripture reference
 *      goes straight to direct lookup and skips planning, fan-out and reranking
 *      entirely.
 *
 * The subquery ceilings here are LIMITS, not targets. The planner may return
 * fewer; it may never return more. A plan that exceeds its ceiling is rejected
 * in query-plan.ts rather than trimmed, because a planner that ignores the
 * budget is a planner that misread the question.
 *
 * Everything in this module is pure and synchronous. It costs nothing to run
 * and it must never be the reason a search is slow.
 */

export type SearchIntent =
  | "exact_reference"
  | "exact_quote"
  | "factual_entity"
  | "broad_concept"
  | "practical_how"
  | "why_question"
  | "narrative"
  | "lecture_specific"
  | "letter_specific"
  | "comparison"
  | "multi_part"
  | "insufficient_or_out_of_domain";

export interface RoutedQuery {
  intent: SearchIntent;
  /** Hard ceiling on approved subqueries for this question. */
  maxSubqueries: number;
  /** True when retrieval can be answered by direct lookup alone. */
  bypassPlanner: boolean;
  /** True when reranking adds nothing — the answer is the referenced verse. */
  bypassRerank: boolean;
  /** Parsed scripture reference, when one was recognised. */
  reference: string | null;
  /** Why the router decided this. Surfaced in telemetry, never to the reader. */
  rationale: string;
}

/**
 * Scripture sigla the corpus actually stores, matching direct_verse_lookup's
 * parser. Anchored so "BGS" or a word merely starting with "so" cannot match.
 */
const SCRIPTURE_SIGLA = ["BG", "SB", "CC", "NOI", "ISO", "BS", "NBS", "MMS"] as const;

const REFERENCE_RE = new RegExp(
  String.raw`^\s*(?:${SCRIPTURE_SIGLA.join("|")})\b[\s.]*` +
    String.raw`(?:(?:adi|madhya|antya|canto|chapter|verse|text|mantra|sloka|shloka)\b[\s.]*)*` +
    String.raw`\d+(?:\s*[.\s]\s*\d+)*(?:\s*-\s*\d+)?\s*$`,
  "i",
);

/** A reference embedded in a longer question ("what does BG 18.66 mean?"). */
const REFERENCE_MENTION_RE = new RegExp(
  String.raw`\b(?:${SCRIPTURE_SIGLA.join("|")})\.?\s*\d+(?:[.\s]\d+)*\b`,
  "i",
);

const QUOTE_RE = /["“”„«»']{1}[^"“”„«»']{12,}["“”„«»']{1}/;

const LECTURE_MARKERS =
  /\b(lecture|lectured|class|morning walk|room conversation|conversation|interview|address|speech|talk given|initiation|arrival address|press conference)\b/i;
const LETTER_MARKERS =
  /\b(letter|letters|wrote to|write to|correspondence|reply to|replied to|recipient|addressed to)\b/i;
/**
 * Note the absence of "who was": that is a person question, and the brief caps
 * person/place/date asks at two subqueries. Narrative is about events —
 * "the story of Prahlāda", "what happened at Kurukṣetra" — not about identity.
 */
const NARRATIVE_MARKERS =
  /\b(story|pastime|lila|līlā|what happened|history of|episode|incident|narrat)/i;
const COMPARISON_MARKERS =
  /\b(compare|comparison|difference between|differ from|versus|vs\.?|contrast|same as|distinguish)\b/i;
const PRACTICAL_MARKERS = /\b(how (?:do|can|should|to)|what should i|steps|practice|practise|method|process for)\b/i;
const WHY_MARKERS = /\b(why|reason|because|cause of|what causes|purpose of)\b/i;
const ENTITY_MARKERS =
  /\b(who|when|where|which year|what year|born|died|appeared|date of|place of|founded|arrived)\b/i;

/** Sub-question separators that indicate genuinely multi-part asks. */
const MULTI_PART_RE = /(?:\?[^?]*\?)|(?:\band also\b)|(?:\bas well as\b)|(?:;\s*(?:and\b)?\s*\w)/i;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Normalises a matched reference into the shape direct_verse_lookup parses.
 * The RPC does its own cleaning, so this only needs to collapse whitespace and
 * uppercase the siglum.
 */
export function normalizeReference(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  return cleaned.replace(/^([A-Za-z]+)/, (m) => m.toUpperCase());
}

export function extractReference(query: string): string | null {
  const trimmed = query.trim();
  if (REFERENCE_RE.test(trimmed)) return normalizeReference(trimmed);
  const mention = trimmed.match(REFERENCE_MENTION_RE);
  return mention ? normalizeReference(mention[0]) : null;
}

/**
 * Routes a raw question. Order matters: the cheapest, most certain
 * classifications are tested first, so a bare "BG 18.66" never falls through to
 * the fuzzy topical heuristics below it.
 */
export function routeQuery(rawQuery: string): RoutedQuery {
  const query = (rawQuery || "").trim();
  const words = wordCount(query);

  if (query.length === 0 || words === 0) {
    return route("insufficient_or_out_of_domain", 0, "empty query", {
      bypassPlanner: true,
      bypassRerank: true,
    });
  }

  // 1. A bare exact reference. No model, no fan-out, no rerank.
  if (REFERENCE_RE.test(query)) {
    return route("exact_reference", 0, "query is a bare scripture reference", {
      bypassPlanner: true,
      bypassRerank: true,
      reference: normalizeReference(query),
    });
  }

  // 2. A reference mentioned inside a question still routes to direct lookup
  //    first, but the surrounding question deserves supporting context, so the
  //    planner is allowed a small budget and reranking stays on.
  const mentioned = extractReference(query);
  if (mentioned && words <= 12) {
    return route("exact_reference", 1, "scripture reference inside a short question", {
      bypassPlanner: false,
      bypassRerank: false,
      reference: mentioned,
    });
  }

  // 3. A quoted span is a hunt for specific wording. Expansion actively hurts:
  //    paraphrases cannot match a quotation the fts_core lane already nails.
  if (QUOTE_RE.test(query)) {
    return route("exact_quote", 1, "query contains a quoted span", { reference: mentioned });
  }

  // 4. Source-shaped asks. Checked before the topical heuristics because
  //    "why did Prabhupada write to..." is a letter question, not a why question.
  if (LETTER_MARKERS.test(query)) {
    return route("letter_specific", 2, "letter/correspondence markers present", { reference: mentioned });
  }
  if (LECTURE_MARKERS.test(query)) {
    return route("lecture_specific", 2, "lecture/conversation markers present", { reference: mentioned });
  }

  // 5. Structural asks that genuinely need several angles.
  if (COMPARISON_MARKERS.test(query)) {
    return route("comparison", 6, "comparison markers present", { reference: mentioned });
  }
  if (MULTI_PART_RE.test(query) || words > 45) {
    return route("multi_part", 6, "multiple sub-questions or a long question", { reference: mentioned });
  }

  if (NARRATIVE_MARKERS.test(query)) {
    return route("narrative", 3, "narrative markers present", { reference: mentioned });
  }

  // 6. Person / place / date questions are narrow; fanning them out invites
  //    plausible-but-wrong neighbours.
  if (ENTITY_MARKERS.test(query) && words <= 14) {
    return route("factual_entity", 2, "entity question, short", { reference: mentioned });
  }

  if (PRACTICAL_MARKERS.test(query)) {
    return route(words > 14 ? "practical_how" : "practical_how", words > 14 ? 5 : 4, "practical/how markers", {
      reference: mentioned,
    });
  }
  if (WHY_MARKERS.test(query)) {
    return route(words > 14 ? "why_question" : "why_question", words > 14 ? 5 : 4, "why markers", {
      reference: mentioned,
    });
  }

  // 7. Very short, non-specific input is more likely a fragment than a question.
  if (words <= 2 && query.length < 12) {
    return route("insufficient_or_out_of_domain", 1, "fragmentary input", { reference: mentioned });
  }

  return route("broad_concept", 4, "no narrower signal matched", { reference: mentioned });
}

function route(
  intent: SearchIntent,
  maxSubqueries: number,
  rationale: string,
  opts: Partial<Pick<RoutedQuery, "bypassPlanner" | "bypassRerank" | "reference">> = {},
): RoutedQuery {
  return {
    intent,
    maxSubqueries,
    bypassPlanner: opts.bypassPlanner ?? false,
    bypassRerank: opts.bypassRerank ?? false,
    reference: opts.reference ?? null,
    rationale,
  };
}

/** Sizing band for the evidence selector, derived from intent. */
export function sizingBandFor(intent: SearchIntent): "direct" | "ordinary" | "broad" {
  switch (intent) {
    case "exact_reference":
    case "exact_quote":
    case "factual_entity":
      return "direct";
    case "comparison":
    case "multi_part":
    case "broad_concept":
      return "broad";
    default:
      return "ordinary";
  }
}
