/**
 * render.ts — The deterministic renderer. It owns every word a devotee reads.
 *
 * Quotation text, source labels, citations, context notices, transitions,
 * headings and the disclosure are all produced here, from VerifiedPassage data
 * that came out of a fresh source-row read. The article plan contributes
 * ORDER and STRUCTURE only; if it is absent, this module orders the passages
 * itself and the page is no less honest, only less shaped.
 *
 * Transitions come from a fixed table and are deliberately non-doctrinal. They
 * say what the next passage IS ("a recorded lecture", "a personal letter"),
 * never what it MEANS. The moment a transition explains a teaching, the AI has
 * started writing doctrine.
 *
 * Context labels are not decoration:
 *   - a letter is correspondence to one person on one date, not a general rule;
 *   - a recorded exchange contains other voices;
 *   - a narrative describes an event, and an event is not automatically an
 *     instruction.
 */
import type { ArticlePlan } from "@/app/lib/search-v2/article-plan";
import { DISCLOSURE } from "@/app/lib/search-v2/article-plan";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";
import { isRenderable } from "@/app/lib/search-v2/refetch";
import { isPrabhupada } from "@/app/lib/15-transcript-speakers";

/** Server-side heading text. Gemini never writes a heading. */
const HEADING_TEMPLATES: Record<string, (subject: string) => string> = {
  foundation: (s) => (s ? `Scriptural foundation: ${s}` : "Scriptural foundation"),
  definition: (s) => (s ? `What ${s} means` : "Definition"),
  explanation: (s) => (s ? `Explanation: ${s}` : "Explanation"),
  cause: (s) => (s ? `Why: ${s}` : "Causes"),
  practice: (s) => (s ? `In practice: ${s}` : "In practice"),
  example: (s) => (s ? `Example: ${s}` : "An example"),
  qualification: (s) => (s ? `A qualification: ${s}` : "A qualification"),
  contrast: (s) => (s ? `By contrast: ${s}` : "By contrast"),
  historical_context: (s) => (s ? `Historical context: ${s}` : "Historical context"),
  further_evidence: (s) => (s ? `Further passages on ${s}` : "Further passages"),
};

/**
 * Allowed transitions. Every one is a statement about the SOURCE, never about
 * the teaching. `[recipient]`/`[year]` are filled from verified fields only.
 */
const TRANSITIONS: Record<string, (p: VerifiedPassage | null) => string> = {
  none: () => "",
  deepening: (p) =>
    p?.sourceType === "purport"
      ? "The following purport develops this point."
      : "The following passage develops this point.",
  source_shift: (p) => {
    switch (p?.sourceType) {
      case "lecture":
        return "In a recorded lecture, Śrīla Prabhupāda discusses the same subject.";
      case "letter":
        return p.recipient && p.date
          ? `The following personal letter was written to ${p.recipient} in ${year(p.date)}.`
          : "The following passage comes from personal correspondence.";
      case "book":
        return "The same subject appears in his books.";
      default:
        return "The next passage comes from a different source.";
    }
  },
  chronology: (p) => (p?.date ? `Written in ${year(p.date)}.` : "The next passage comes from a different period."),
  practice: () => "The next passage concerns practice.",
  contrast: () => "The next passage draws a contrast.",
  qualification: () => "The next passage adds a qualification.",
};

function year(date: string | null): string {
  if (!date) return "";
  const m = date.match(/^(\d{4})/);
  return m ? m[1] : date;
}

export type ContextNoticeKind = "letter" | "conversation" | "narrative";

export interface RenderedBlock {
  passageKey: string;
  sourceType: VerifiedPassage["sourceType"];
  /** Exact stored text. Never edited, never shortened. */
  text: string;
  reference: string | null;
  url: string | null;
  /** Shown above the passage when its type needs framing. */
  contextNotice: string | null;
  contextNoticeKind: ContextNoticeKind | null;
  /** Non-doctrinal lead-in, or empty. */
  transition: string;
  /** Verse layers, present only for verses that have them. */
  sanskrit: string | null;
  transliteration: string | null;
  synonyms: string | null;
  purport: string | null;
  /** "also appears in N places" affordance. */
  alsoAppearsIn: number;
}

export interface RenderedSection {
  heading: string | null;
  blocks: RenderedBlock[];
}

export interface RenderedArticle {
  title: string;
  articleType: string;
  /** Neutral one-line map of what the sources are. Never a summary of doctrine. */
  sourceMap: string | null;
  sections: RenderedSection[];
  closing: { kind: "none" | "final_source" | "further_study"; blocks: RenderedBlock[] };
  citations: { ref: string; url: string | null; sourceType: string }[];
  disclosure: string;
  /** True when the plan came from the model; false when ordered deterministically. */
  planned: boolean;
  evidenceInsufficient: boolean;
}

export function contextNoticeFor(p: VerifiedPassage): { text: string; kind: ContextNoticeKind } | null {
  switch (p.sourceType) {
    case "letter":
      // Guarded by isRenderable, but re-checked: an unlabelled letter must never
      // reach a reader looking like general instruction.
      if (!p.recipient || !p.date) return null;
      return {
        text: `Specific correspondence — Letter to ${p.recipient}, ${year(p.date)}`,
        kind: "letter",
      };
    case "lecture":
      // The speaker column is a deterministic read of the paragraph's own
      // "Name:" prefix (migration 20260801120000). When it names someone else,
      // the notice must say so plainly — a devotee could otherwise stand up in
      // class and quote a visitor's words as Śrīla Prabhupāda's. When there is
      // no label the speaker is honestly unknown, never assumed to be his.
      if (p.speaker && !isPrabhupada(p.speaker)) {
        return {
          text: `Spoken by ${p.speaker} — not Śrīla Prabhupāda`,
          kind: "conversation",
        };
      }
      if (p.speaker && isPrabhupada(p.speaker)) {
        return {
          text: "Recorded exchange — spoken by Śrīla Prabhupāda",
          kind: "conversation",
        };
      }
      if (p.speakerConfidence === "unknown") {
        return {
          text: "Speaker not identified — part of a recorded conversation",
          kind: "conversation",
        };
      }
      return {
        text: "Recorded exchange — words spoken by Śrīla Prabhupāda highlighted",
        kind: "conversation",
      };
    default:
      return null;
  }
}

function toBlock(p: VerifiedPassage, transition: string): RenderedBlock {
  const notice = contextNoticeFor(p);
  return {
    passageKey: p.passageKey,
    sourceType: p.sourceType,
    text: p.text,
    reference: p.reference,
    url: p.vedabaseUrl,
    contextNotice: notice?.text ?? null,
    contextNoticeKind: notice?.kind ?? null,
    transition,
    sanskrit: p.sanskrit,
    transliteration: p.transliteration,
    synonyms: p.synonyms,
    purport: p.purport,
    alsoAppearsIn: p.selection.candidate.alternates?.length ?? 0,
  };
}

/**
 * A neutral description of what the reader is looking at. Counts source types;
 * says nothing about what they teach.
 */
function buildSourceMap(passages: VerifiedPassage[]): string | null {
  if (passages.length === 0) return null;
  const labels: Record<string, [string, string]> = {
    verse: ["verse", "verses"],
    purport: ["purport", "purports"],
    book: ["book passage", "book passages"],
    lecture: ["recorded talk", "recorded talks"],
    letter: ["letter", "letters"],
  };
  const counts = new Map<string, number>();
  for (const p of passages) counts.set(p.sourceType, (counts.get(p.sourceType) ?? 0) + 1);
  const parts = [...counts.entries()].map(([t, n]) => {
    const [one, many] = labels[t] ?? [t, t];
    return `${n} ${n === 1 ? one : many}`;
  });
  if (parts.length === 1) return `Drawn from ${parts[0]}.`;
  return `Drawn from ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

/** A title the renderer can produce with no model at all. */
function deterministicTitle(question: string, passages: VerifiedPassage[]): string {
  const refs = passages
    .map((p) => p.reference)
    .filter((r): r is string => Boolean(r))
    .slice(0, 2);
  const q = question.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
  const subject = q.length > 0 ? q.charAt(0).toUpperCase() + q.slice(1) : "Passages";
  const head = subject.length > 70 ? subject.slice(0, 67).trimEnd() + "…" : subject;
  return refs.length > 0 ? `${head} — ${refs.join(", ")}` : head;
}

export interface RenderInput {
  question: string;
  passages: VerifiedPassage[];
  plan: ArticlePlan | null;
}

/**
 * Builds the article. With a plan, follows its structure; without one, emits a
 * single unheaded section in selector order. Both paths render identical
 * passage text, because both read the same verified data.
 */
export function renderArticle(input: RenderInput): RenderedArticle {
  const { question, plan } = input;
  // Second gate after re-fetch: nothing unlabellable is rendered.
  const passages = input.passages.filter(isRenderable);
  const byKey = new Map(passages.map((p) => [p.passageKey, p]));

  if (passages.length === 0) {
    return {
      title: deterministicTitle(question, []),
      articleType: "evidence_insufficient",
      sourceMap: null,
      sections: [],
      closing: { kind: "none", blocks: [] },
      citations: [],
      disclosure: DISCLOSURE,
      planned: false,
      evidenceInsufficient: true,
    };
  }

  const used = new Set<string>();
  const sections: RenderedSection[] = [];

  if (plan) {
    for (const s of plan.sections) {
      const blocks: RenderedBlock[] = [];
      for (const [i, id] of s.passage_ids.entries()) {
        const p = byKey.get(id);
        if (!p || used.has(id)) continue;
        used.add(id);
        // Only the first block of a section carries the transition; a lead-in
        // before every passage reads as narration.
        const transition = i === 0 ? (TRANSITIONS[s.transition_type]?.(p) ?? "") : "";
        blocks.push(toBlock(p, transition));
      }
      if (blocks.length === 0) continue; // a section whose passages all dropped
      const heading = HEADING_TEMPLATES[s.heading_key]?.(s.short_subject.trim()) ?? null;
      sections.push({ heading, blocks });
    }
  }

  // Anything the plan did not place — or every passage, with no plan — is shown
  // rather than silently discarded.
  const leftovers = passages.filter((p) => !used.has(p.passageKey));
  if (leftovers.length > 0) {
    const blocks = leftovers.map((p, i) => toBlock(p, i === 0 && sections.length > 0 ? TRANSITIONS.source_shift(p) : ""));
    sections.push({
      heading: sections.length > 0 ? HEADING_TEMPLATES.further_evidence("") : null,
      blocks,
    });
    for (const p of leftovers) used.add(p.passageKey);
  }

  // Closing: a final source, a study list, or nothing. Never an AI message.
  let closing: RenderedArticle["closing"] = { kind: "none", blocks: [] };
  if (plan && plan.closing.kind !== "none") {
    const blocks = plan.closing.passage_ids
      .map((id) => byKey.get(id))
      .filter((p): p is VerifiedPassage => Boolean(p))
      .map((p) => toBlock(p, ""));
    if (blocks.length > 0) closing = { kind: plan.closing.kind, blocks };
  }

  const citations = passages
    .filter((p) => used.has(p.passageKey))
    .map((p) => ({ ref: p.reference ?? p.passageKey, url: p.vedabaseUrl, sourceType: p.sourceType }));

  const title = plan?.title?.trim() || deterministicTitle(question, passages);

  return {
    title,
    // The planner's own shape when it produced one; otherwise the shape this
    // renderer just built. Descriptive only — nothing branches on it.
    articleType: plan?.article_type ?? "unplanned",
    sourceMap: buildSourceMap(passages),
    sections,
    closing,
    citations,
    disclosure: DISCLOSURE,
    planned: Boolean(plan),
    evidenceInsufficient: false,
  };
}
