/**
 * adapt.ts — Maps V2 pipeline output onto the existing wire contract.
 *
 * The V1 response shape (`SearchResults`) is what the live renderer and the
 * telemetry endpoints already understand. Rewriting the UI to match a new shape
 * is a separate change with its own risk, and the brief is explicit that the
 * streaming/UI architecture should not be rewritten to look modern. So V2
 * produces the same contract, filled from verified data.
 *
 * The important property: `narrative` is assembled ONLY from
 * `RenderedArticle` — headings the server generated, transitions from a fixed
 * table, and passage text that came out of a fresh source-row read. No string in
 * here originates with a model.
 */
import type { RenderedArticle, RenderedBlock } from "@/app/lib/search-v2/render";
import type { PipelineOutput } from "@/app/lib/search-v2/pipeline";
import type { Citation, SearchResults, MainFlowNode } from "@/app/lib/types/01-search";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CITATION_TYPE: Record<string, Citation["type"]> = {
  verse: "verse",
  purport: "verse",
  book: "prose",
  lecture: "transcript",
  letter: "letter",
};

const FLOW_TYPE: Record<string, MainFlowNode["type"]> = {
  verse: "verse",
  purport: "verse",
  book: "prose",
  lecture: "lecture",
  letter: "letter",
};

function renderBlockHtml(b: RenderedBlock): string {
  const parts: string[] = [];

  if (b.transition) {
    parts.push(`<p class="asp-transition">${escapeHtml(b.transition)}</p>`);
  }
  if (b.contextNotice) {
    parts.push(
      `<p class="asp-context-notice" data-kind="${escapeHtml(b.contextNoticeKind ?? "")}">${escapeHtml(
        b.contextNotice,
      )}</p>`,
    );
  }

  const layers: string[] = [];
  if (b.sanskrit) layers.push(`<p class="asp-sanskrit">${escapeHtml(b.sanskrit)}</p>`);
  if (b.transliteration) layers.push(`<p class="asp-translit">${escapeHtml(b.transliteration)}</p>`);

  const cite = b.reference
    ? b.url
      ? `<cite><a href="${escapeHtml(b.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(b.reference)}</a></cite>`
      : `<cite>${escapeHtml(b.reference)}</cite>`
    : "";

  parts.push(
    `<blockquote class="asp-passage" data-source="${escapeHtml(b.sourceType)}" data-passage="${escapeHtml(b.passageKey)}">` +
      layers.join("") +
      `<p>${escapeHtml(b.text)}</p>` +
      cite +
      `</blockquote>`,
  );

  if (b.alsoAppearsIn > 0) {
    const n = b.alsoAppearsIn;
    parts.push(
      `<p class="asp-also-appears">This passage also appears in ${n} other place${n === 1 ? "" : "s"}.</p>`,
    );
  }

  return parts.join("\n");
}

/** Assembles the narrative HTML. Every string here is server-owned. */
export function articleToHtml(article: RenderedArticle): string {
  const out: string[] = [];

  if (article.evidenceInsufficient) {
    out.push(
      `<p class="asp-insufficient">No passage in the library directly answers this question. ` +
        `Rather than assemble an answer from passages that only touch the subject, nothing is shown here.</p>`,
    );
  }

  if (article.sourceMap) {
    out.push(`<p class="asp-source-map">${escapeHtml(article.sourceMap)}</p>`);
  }

  for (const section of article.sections) {
    if (section.heading) out.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    for (const b of section.blocks) out.push(renderBlockHtml(b));
  }

  if (article.closing.blocks.length > 0) {
    out.push(
      `<h2>${article.closing.kind === "further_study" ? "Further passages to study" : "A final passage"}</h2>`,
    );
    for (const b of article.closing.blocks) out.push(renderBlockHtml(b));
  }

  out.push(`<p class="asp-disclosure">${escapeHtml(article.disclosure)}</p>`);
  return out.join("\n");
}

/**
 * Produces the wire response. `books` is left empty: V2 groups by structural
 * role rather than by book, and inventing a book grouping the pipeline did not
 * compute would be presenting a shape that no longer reflects the reasoning.
 */
export function adaptToSearchResults(query: string, out: PipelineOutput): SearchResults {
  const { article, telemetry } = out;
  const blocks = article.sections.flatMap((s) => s.blocks);

  const citations: Citation[] = blocks.map((b) => ({
    ref: b.reference ?? b.passageKey,
    book: b.sourceType,
    url: b.url ?? "",
    type: CITATION_TYPE[b.sourceType] ?? "prose",
    title: b.reference ?? "",
  }));

  const mainFlowItems: MainFlowNode[] = blocks.map((b) => ({
    type: FLOW_TYPE[b.sourceType] ?? "prose",
    id: b.passageKey,
    ref: b.reference ?? "",
    url: b.url ?? "",
  }));

  return {
    query,
    narrative: articleToHtml(article),
    totalResults: blocks.length,
    citations,
    books: [],
    mainFlowItems,
    intro: article.title,
    validated: true, // every block came from refetchAndVerify
    droppedBlocks: telemetry.droppedOnRefetch,
    requestId: telemetry.requestId,
    retrievalStatus: "complete",
    degradedStages: telemetry.degradedStages,
    disabledLanes: [],
    articleVerseIds: blocks.filter((b) => b.sourceType === "verse").map((b) => b.passageKey),
  };
}
