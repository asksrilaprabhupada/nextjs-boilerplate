/**
 * 01-narrative-response.tsx — The answer, printed from one list (cinematic redesign)
 *
 * Designs: docs/redesign/designs/Answer.dc.html and PhoneAnswer.dc.html.
 *
 * The server sends `results.passages`: every passage the reranker judged
 * relevant, words included, in the reranker's order. This component walks that
 * list from first to last and prints each passage — its index, its label, its
 * words, and the citation bar (medal + number, "Read in full ↗", Copy). The
 * first passage is the lead card. There is no look-up table, no id-joining, no
 * second list, and nothing written by a model: no title, no summary, no
 * context. Long passages FOLD (preview + expand in place); they are never
 * truncated away. The words and the matched-sentence emphasis come SOLELY from
 * the shared fold helpers (app/lib/10-passage-fold.ts); the emphasis is
 * restyled as the design's violet mark. The design's three-colour "Highlights"
 * legend is not shown: the search does not produce those kinds.
 *
 * Around the passages: the short "read in full" note at the top, the Dig
 * Deeper card ("N more passages retrieved in this search", opening Dig
 * Deeper), the Advanced card only when Advanced is switched on, and the full
 * disclaimer beside the photograph of Śrīla Prabhupāda at his desk.
 */
"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import SearchFeedback from "../search/06-search-feedback";
import CitationBar from "./04-citation-bar";
import { DigDeeperCard, type DigSource } from "./03-cinematic-dig-deeper";
import {
  buildFoldPreviewHtml,
  highlightParagraphsHtml,
  buildSectionText,
  type PassageType,
} from "@/app/lib/10-passage-fold";
import { stripPurportBoilerplate } from "@/app/lib/09-purport-format";
import { ADVANCED_ENABLED } from "@/app/lib/28-advanced-flag";
import type { SearchPassage, SearchResults } from "@/app/lib/types/01-search";

/** The words a card shows, as copied with its reference. */
function fullTextFor(p: SearchPassage): string {
  if (p.type === "verse") {
    const parts: string[] = [];
    if (p.text?.trim()) parts.push(p.text.trim());
    const pur = stripPurportBoilerplate(p.purport || "").trim();
    if (pur) parts.push(pur);
    return parts.join("\n\n");
  }
  return (p.text || "").trim();
}

function BookIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#8a5a0b" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 21V5" />
      <path d="M9 7h6" />
    </svg>
  );
}

function PassageCard({ p, index, queryTerms }: { p: SearchPassage; index: number; queryTerms: string[] }) {
  const [open, setOpen] = useState(false);
  const lead = index === 0;
  const n = String(index + 1).padStart(2, "0");

  let words: ReactNode;
  if (p.type === "verse") {
    const translationHtml = highlightParagraphsHtml(p.text || "", undefined, queryTerms);
    const purport = (p.purport || "").trim();
    const preview = purport ? buildFoldPreviewHtml({ type: "purport", text: purport, queryTerms }) : null;
    const purportFull = purport ? highlightParagraphsHtml(purport, undefined, queryTerms) : "";
    words = (
      <>
        <div className="asp-ptext" dangerouslySetInnerHTML={{ __html: translationHtml }} />
        {preview && preview.previewHtml && (
          <div className="asp-purport">
            {p.purportLabel && <p className="asp-passage-label">{p.purportLabel}</p>}
            <div className="asp-body" dangerouslySetInnerHTML={{ __html: open ? purportFull : preview.previewHtml }} />
            {preview.truncated && (
              <button type="button" className="asp-fold-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? "Show less ↑" : "Read the full purport ↓"}
              </button>
            )}
          </div>
        )}
      </>
    );
  } else {
    const body = p.text || "";
    const foldType: PassageType = p.type === "book" ? "prose" : (p.type as PassageType);
    const preview = buildFoldPreviewHtml({ type: foldType, text: body, queryTerms });
    const fullHtml = highlightParagraphsHtml(buildSectionText(body), undefined, queryTerms, foldType);
    words = (
      <>
        <div className="asp-body" dangerouslySetInnerHTML={{ __html: open ? fullHtml : preview.previewHtml }} />
        {preview.truncated && (
          <button type="button" className="asp-fold-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Show less ↑" : "Read in full ↓"}
          </button>
        )}
      </>
    );
  }

  return (
    <article
      id={`source-${index}`}
      className={`asp-passage${lead ? " asp-passage-lead" : ""} asp-rise`}
      style={{ animationDelay: `${300 + Math.min(index, 6) * 70}ms` }}
      aria-label={`Passage ${index + 1}`}
      data-passage-type={p.type}
    >
      <div className="asp-passage-head">
        <span aria-hidden="true" className="asp-passage-idx">{n}</span>
        {p.label && <p className="asp-passage-label">{p.label}</p>}
      </div>
      {p.provenanceNote && <p className="asp-passage-note">{p.provenanceNote}</p>}
      {p.contextNotice && <p className="asp-passage-context">{p.contextNotice}</p>}
      {words}
      {p.alsoAppearsIn > 0 && (
        <p className="asp-also">
          This passage also appears in {p.alsoAppearsIn} other {p.alsoAppearsIn === 1 ? "place" : "places"}.
        </p>
      )}
      <CitationBar passage={p} copyText={fullTextFor(p)} glint={lead} />
    </article>
  );
}

interface Props {
  results: SearchResults;
  onSearch: (q: string) => void;
  searchLogId?: string | null;
  /** Opens the Dig Deeper screen, optionally on one source. */
  onOpenDigDeeper: (source?: DigSource) => void;
}

export default function NarrativeResponse({ results, onSearch, searchLogId, onOpenDigDeeper }: Props) {
  const passages = results.passages || [];
  const queryTerms = results.queryTerms || [];
  const additional = results.additional || [];

  return (
    <main className="asp-answer-main asp-sec">
      <div className="asp-answer-col">
        <aside aria-label="Read in full" className="asp-disc-short">
          <BookIcon />
          <p>
            These are passages, not the whole teaching. Read each one in full on Vedabase or in the book before you rely on it.{" "}
            <a href="#asp-read-full">Why this matters</a>
          </p>
        </aside>

        {results.totalResults === 0 ? (
          <div className="asp-panel" style={{ marginTop: 40 }}>
            <p className="asp-panel-title">
              {results.retrievalStatus === "degraded"
                ? "No passages were found in the sources that were available."
                : "No passages found for that phrasing."}
            </p>
            {results.suggestion && results.suggestionDisplay && (
              <p className="asp-panel-text" style={{ marginBottom: 8 }}>
                Did you mean{" "}
                <button type="button" className="asp-fold-btn" style={{ margin: 0, display: "inline-flex" }} onClick={() => onSearch(results.suggestion!)}>
                  {results.suggestionDisplay}
                </button>
                ?
              </p>
            )}
            <p className="asp-panel-text">
              Try rephrasing your question — or a different spelling (Krsna, Krishna, and Kṛṣṇa all work).
            </p>
            <div className="asp-panel-actions">
              {["What is the soul?", "How to chant with attention", "Overcoming anger"].map((q) => (
                <button key={q} type="button" className="asp-btn-ghost" onClick={() => onSearch(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="asp-passages">
              {passages.map((p, i) => (
                <PassageCard key={`${results.query}:${p.type}:${p.reference ?? p.label}:${i}`} p={p} index={i} queryTerms={queryTerms} />
              ))}
            </div>

            <div className="asp-feedback-slot">
              <SearchFeedback searchLogId={searchLogId || null} />
            </div>

            <DigDeeperCard
              list={additional}
              totalCount={results.additionalCount}
              onOpen={onOpenDigDeeper}
            />

            {ADVANCED_ENABLED && (
              <section className="asp-advcard asp-dark" aria-labelledby="asp-adv-h">
                <div aria-hidden="true" className="asp-advcard-glow-a" />
                <div aria-hidden="true" className="asp-advcard-glow-b" />
                <div style={{ position: "relative" }}>
                  <p className="asp-eyebrow" style={{ letterSpacing: "0.32em" }}>Advanced</p>
                  <h2 id="asp-adv-h">
                    What did the <em>previous ācāryas</em> say?
                  </h2>
                  <p className="asp-advcard-sub">
                    The same question, searched in the books of the ācāryas from Śrī Caitanya Mahāprabhu to Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura, in English translation. It opens on its own page.
                  </p>
                  <Link className="asp-advcard-link" href={`/advanced?q=${encodeURIComponent(results.query)}`}>
                    Open Advanced
                    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                </div>
              </section>
            )}
          </>
        )}

        <section id="asp-read-full" aria-labelledby="asp-disc-h" className="asp-disc-full">
          <figure className="asp-disc-fig">
            <div className="asp-disc-frame">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/redesign/photos/translating.webp"
                alt="Śrīla Prabhupāda at his desk, working on his books"
                width={526}
                height={520}
                loading="lazy"
                decoding="async"
              />
            </div>
          </figure>
          <p className="asp-kicker">Before you rely on a passage</p>
          <h2 id="asp-disc-h">
            Read his words <em className="asp-grad-em">in full.</em>
          </h2>
          <p className="asp-disc-text">
            This site finds Śrīla Prabhupāda&apos;s words and shows exactly where they come from. It does not give the whole teaching. Read every passage in its full context, on Vedabase or in the original book, and ask senior devotees when something is unclear. We cannot take responsibility for how a passage is understood.
          </p>
          <p className="asp-disc-tag">Nothing added. Nothing invented.</p>
          <Link className="asp-btn-ghost" href="/?entrance=0">Ask another question</Link>
        </section>
      </div>
    </main>
  );
}
