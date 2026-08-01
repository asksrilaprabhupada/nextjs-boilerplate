/**
 * 01-narrative-response.tsx — The answer, printed from one list.
 *
 * The server sends `results.passages`: every passage the reranker judged
 * relevant, words included, in the reranker's order. This component walks that
 * list from first to last and prints each passage — its label, its words, its
 * citation link, its copy button. There is no look-up table, no id-joining, and
 * no second list: if a field is needed to render a passage, it arrived on the
 * passage.
 *
 * Two views of the SAME list: "Essay" prints it in order; "By source" groups it
 * under book names. Same passages, same words, arranged differently — nothing
 * is hidden and nothing is dropped in either view. Long passages FOLD (preview
 * + expand in place); they are never truncated away.
 *
 * All verbatim bodies and the matched-sentence emphasis come SOLELY from the
 * shared fold helpers (app/lib/10-passage-fold.ts) — no philosophy is ever
 * computed or paraphrased here.
 */
"use client";

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import Link from "next/link";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import SearchFeedback from "../search/06-search-feedback";
import {
  buildFoldPreviewHtml,
  highlightParagraphsHtml,
  buildSectionText,
  type PassageType,
} from "@/app/lib/10-passage-fold";
import { stripPurportBoilerplate } from "@/app/lib/09-purport-format";
import { EASE, SPRING_SETTLE } from "@/app/lib/11-motion";
import { getBookName } from "@/app/lib/12-provenance";

/* ─────────────────────────── Data contract ───────────────────────────
   The response types live in the shared server↔client contract
   (app/lib/types/01-search.ts) and are re-exported here so existing
   importers (e.g. 02-dig-deeper-modal) keep working unchanged. */

import type {
  AdditionalSearchPassage,
  Citation,
  SearchPassage,
  SearchResults,
  VerseHit,
  ProseHit,
  TranscriptHit,
  LetterHit,
} from "@/app/lib/types/01-search";

export type {
  Citation,
  SearchPassage,
  SearchResults,
  VerseHit,
  ProseHit,
  TranscriptHit,
  LetterHit,
};

/* ─────────────────────────── Citation display ─────────────────────────── */

// Community dot/space abbreviations for display (never the biblical colon form).
const SCRIPTURE_DISPLAY: Record<string, string> = {
  BG: "Bg.", SB: "SB", CC: "Cc.", NOI: "NoI", ISO: "ISO", BS: "Bs.",
  NBS: "NBS", MMS: "MMS", LOB: "LoB", KB: "KB", NOD: "NoD",
};

function formatCiteRef(ref: string): string {
  const m = ref.match(/^([A-Za-z]{2,4})\s+(.+)$/);
  if (m) {
    const key = m[1].toUpperCase();
    if (SCRIPTURE_DISPLAY[key]) return `${SCRIPTURE_DISPLAY[key]} ${m[2]}`;
  }
  return ref;
}

/** Short citation text for a passage's chip. */
function citeFor(p: SearchPassage): string {
  if (p.type === "book") return getBookName(p.reference || "");
  if (p.type === "lecture") {
    return ["Lecture", p.date ? new Date(p.date).getFullYear().toString() : "", p.location]
      .filter(Boolean)
      .join(" · ");
  }
  if (p.type === "letter") {
    return ["Letter", p.recipient ? `to ${p.recipient}` : "", p.date ? new Date(p.date).getFullYear().toString() : ""]
      .filter(Boolean)
      .join(" · ");
  }
  return formatCiteRef(p.reference || p.id);
}

/** The book-shelf name a passage files under in the "By source" view. */
function shelfFor(p: SearchPassage): string {
  if (p.type === "lecture") return "Lectures & Conversations";
  if (p.type === "letter") return "Letters";
  if (p.type === "book") return getBookName(p.reference || "");
  const m = (p.reference || "").match(/^([A-Za-z]{2,4})\b/);
  return m ? getBookName(m[1].toLowerCase()) : "Other sources";
}

function scrollToSource(id: string) {
  document.getElementById(`source-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** Row id inside a namespaced passage key ("verse:<uuid>" → "<uuid>"). */
function rowIdOf(p: SearchPassage): string {
  return p.id.slice(p.id.indexOf(":") + 1);
}

/** Cite-dot palette key. */
function dotType(p: SearchPassage): string {
  return p.type === "lecture" ? "lecture" : p.type === "letter" ? "letter" : p.type;
}

/* ─────────────────────────── Copy button (icon morphs to a check) ─────────────────────────── */

function CopyButton({ onCopy, label = "Copy" }: { onCopy: () => void; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <motion.button
      type="button"
      className="copy-chip"
      onClick={handle}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      aria-label="Copy passage with reference"
    >
      <span className="copy-ico" aria-hidden>
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.svg key="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={SPRING_SETTLE}>
              <path d="M20 6 9 17l-5-5" />
            </motion.svg>
          ) : (
            <motion.svg key="copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ duration: 0.16 }}>
              <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </motion.svg>
          )}
        </AnimatePresence>
      </span>
      {copied ? "Copied" : label}
    </motion.button>
  );
}

/* ─────────────────────────── Label + notice lines ─────────────────────────── */

function LabelLine({ p }: { p: SearchPassage }) {
  if (!p.label && !p.provenanceNote) return null;
  return (
    <div className="passage-label">
      {p.label && <span>{p.label}</span>}
      {p.provenanceNote && <span className="passage-label-note">{p.provenanceNote}</span>}
    </div>
  );
}

/* ─────────────────────────── One passage card ─────────────────────────── */

function PassageCard({
  p, index = 0, queryTerms, onCopy, onOpenPreview,
}: {
  p: SearchPassage;
  index?: number;
  queryTerms: string[];
  onCopy: (p: SearchPassage) => void;
  onOpenPreview: (p: SearchPassage) => void;
}) {
  const [open, setOpen] = useState(false);
  // Compose-in: only the first ~10 passages stagger; the rest appear at once.
  const entranceDelay = index < 10 ? index * 0.07 : 0;

  const foot = (
    <div className="passage-foot">
      <motion.button className="cite-chip" onClick={() => onOpenPreview(p)} whileTap={{ scale: 0.97 }} aria-label={`Preview ${citeFor(p)}`}>
        <span className="cite-dot" data-type={dotType(p)} aria-hidden />
        {citeFor(p)}
      </motion.button>
      {p.url && (
        <a
          className="cite-chip cite-external"
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${citeFor(p)} on Vedabase in a new tab`}
        >
          ↗
        </a>
      )}
      <CopyButton onCopy={() => onCopy(p)} />
    </div>
  );

  const full = (innerHtml: string) => (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="full"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.36, ease: EASE.decelerate }}
          style={{ overflow: "hidden" }}
        >
          <div className="passage-body" dangerouslySetInnerHTML={{ __html: innerHtml }} />
        </motion.div>
      )}
    </AnimatePresence>
  );

  let content: ReactNode;

  if (p.type === "verse") {
    const translationHtml = highlightParagraphsHtml(p.text || "", undefined, queryTerms);
    const purport = (p.purport || "").trim();
    const preview = purport ? buildFoldPreviewHtml({ type: "purport", text: purport, queryTerms }) : null;
    const purportFull = purport ? highlightParagraphsHtml(purport, undefined, queryTerms) : "";
    content = (
      <>
        <div className="verse-translation" dangerouslySetInnerHTML={{ __html: translationHtml }} />
        {preview && preview.previewHtml && (
          <div className="purport-block">
            {p.purportLabel && (
              <div className="passage-label">
                <span>{p.purportLabel}</span>
              </div>
            )}
            {!open && <div className="passage-body" dangerouslySetInnerHTML={{ __html: preview.previewHtml }} />}
            {full(purportFull)}
            {preview.truncated && (
              <button className="fold-expand-btn" onClick={() => setOpen(o => !o)}>
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
    content = (
      <div className={p.type === "letter" ? "letter-body" : undefined}>
        {!open && <div className="passage-body" dangerouslySetInnerHTML={{ __html: preview.previewHtml }} />}
        {full(fullHtml)}
        {preview.truncated && (
          <button className="fold-expand-btn" onClick={() => setOpen(o => !o)}>
            {open ? "Show less ↑" : "Read in full ↓"}
          </button>
        )}
      </div>
    );
  }

  return (
    <motion.article
      id={`source-${p.id}`}
      className="passage"
      data-passage-type={p.type}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE.decelerate, delay: entranceDelay }}
    >
      <LabelLine p={p} />
      {p.contextNotice && <p className="context-notice font-body">{p.contextNotice}</p>}
      {content}
      {p.alsoAppearsIn > 0 && (
        <p className="also-appears font-body">
          This passage also appears in {p.alsoAppearsIn} other {p.alsoAppearsIn === 1 ? "place" : "places"}.
        </p>
      )}
      {foot}
    </motion.article>
  );
}

/* ─────────────────────────── Citation preview sheet ─────────────────────────── */

function PreviewSheet({
  p, onClose, onCopy,
}: {
  p: SearchPassage;
  onClose: () => void;
  onCopy: (p: SearchPassage) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  let html = "";
  if (p.type === "verse") {
    const parts: string[] = [];
    if (p.text?.trim()) parts.push(highlightParagraphsHtml(p.text, undefined, []));
    if ((p.purport || "").trim()) {
      if (p.purportLabel) parts.push(`<div class="passage-label">${p.purportLabel}</div>`);
      parts.push(highlightParagraphsHtml(p.purport || "", undefined, []));
    }
    html = parts.join("");
  } else {
    const foldType: PassageType = p.type === "book" ? "prose" : (p.type as PassageType);
    html = highlightParagraphsHtml(buildSectionText(p.text || ""), undefined, [], foldType);
  }

  return (
    <>
      <motion.div
        className="sheet-scrim"
        onClick={onClose}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="preview-sheet"
        role="dialog" aria-label={`${citeFor(p)} full passage`}
        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
        transition={{ duration: 0.28, ease: EASE.decelerate }}
      >
        <div className="preview-head">
          <span className="cite-chip" aria-hidden><span className="cite-dot" data-type={dotType(p)} />{citeFor(p)}</span>
          <button className="sheet-close" onClick={onClose} aria-label="Close preview">&times;</button>
        </div>
        <LabelLine p={p} />
        <div className="preview-body passage-body" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="preview-actions">
          <CopyButton onCopy={() => onCopy(p)} label="Copy with reference" />
          <span className="preview-links">
            {p.type === "verse" && (
              <Link className="vedabase-link" href={`/verse/${rowIdOf(p)}`}>Read this verse →</Link>
            )}
            {p.url && (
              <a className="vedabase-link" href={p.url} target="_blank" rel="noopener noreferrer">Open in Vedabase ↗</a>
            )}
          </span>
        </div>
      </motion.div>
    </>
  );
}

/* ─────────────────────────── The second tier ───────────────────────────
   Every passage that survived retrieval but was not rendered in full: label,
   citation, one sentence-safe snippet, a Vedabase link when one exists.
   Collapsed by default (progressive disclosure — complete, not drowning), and
   expanding re-requests NOTHING: the data is already in the response. */

const ADDITIONAL_GROUPS: { type: AdditionalSearchPassage["type"]; title: string }[] = [
  { type: "verse", title: "Verses" },
  { type: "purport", title: "Purports" },
  { type: "book", title: "Books" },
  { type: "lecture", title: "Lectures & Conversations" },
  { type: "letter", title: "Letters" },
];

function AdditionalTier({ list, truncated }: { list: AdditionalSearchPassage[]; truncated?: boolean }) {
  if (list.length === 0) return null;
  const count = list.length.toLocaleString("en-US");
  return (
    <details className="additional-tier">
      <summary className="font-body">
        {count} more {list.length === 1 ? "passage" : "passages"} — every one the library found, as citations
      </summary>
      {truncated && (
        <p className="additional-truncated font-body">
          This list was shortened to fit the response — the counts above are the true totals.
        </p>
      )}
      {ADDITIONAL_GROUPS.map(({ type, title }) => {
        const group = list.filter((a) => a.type === type);
        if (group.length === 0) return null;
        return (
          <section key={type} className="additional-group">
            <h4 className="font-body">
              {title} · {group.length.toLocaleString("en-US")}
            </h4>
            <ul>
              {group.map((a) => (
                <li key={a.id} className="additional-row">
                  <div className="additional-label font-body">
                    <span>{a.label}</span>
                    {a.provenanceNote && <span className="passage-label-note">{a.provenanceNote}</span>}
                    {a.url && (
                      <a href={a.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.reference || a.label} on Vedabase in a new tab`}>
                        ↗
                      </a>
                    )}
                  </div>
                  {a.snippet && <p className="additional-snippet font-body">{a.snippet}</p>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </details>
  );
}

/* ─────────────────────────── Main component ─────────────────────────── */

interface Props {
  results: SearchResults | null;
  isLoading: boolean;
  isStreaming?: boolean;
  streamingNarrative?: string;
  onSearch: (q: string) => void;
  searchLogId?: string | null;
  viewMode: "article" | "references";
  onViewModeChange: (mode: "article" | "references") => void;
}

export default function NarrativeResponse({ results, isLoading, onSearch, searchLogId, viewMode, onViewModeChange }: Props) {
  const [preview, setPreview] = useState<SearchPassage | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const nextIdxRef = useRef(0);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setPreview(null); }, [results?.query]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // The bloom: each emphasized sentence glows in ONCE when it scrolls into view,
  // one at a time (a small serial queue), then settles to a calm resting tint.
  // A MutationObserver picks up sentences revealed by expanding a passage.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !results) return;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const queue: HTMLElement[] = [];
    let busy = false;
    let timer: number | undefined;

    const runNext = () => {
      if (busy) return;
      const el = queue.shift();
      if (!el) return;
      busy = true;
      el.classList.add("bloom");
      timer = window.setTimeout(() => { busy = false; runNext(); }, reduce ? 0 : 780);
    };

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        io.unobserve(el);
        if (el.dataset.bloomed) continue;
        el.dataset.bloomed = "1";
        if (reduce) { el.classList.add("bloom"); continue; }
        queue.push(el);
        runNext();
      }
    }, { threshold: 0.6 });

    const observe = (el: HTMLElement) => { if (!el.dataset.bloomed) io.observe(el); };
    shell.querySelectorAll<HTMLElement>(".hl-sentence").forEach(observe);

    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const el = n as HTMLElement;
          if (el.matches(".hl-sentence")) observe(el);
          el.querySelectorAll<HTMLElement>(".hl-sentence").forEach(observe);
        });
      }
    });
    mo.observe(shell, { childList: true, subtree: true });

    return () => { io.disconnect(); mo.disconnect(); if (timer) window.clearTimeout(timer); };
  }, [results]);

  const queryTerms = useMemo(() => results?.queryTerms || [], [results]);
  const passages = useMemo(() => results?.passages || [], [results]);

  // "By source": the SAME list, grouped under book names. Shelves appear in the
  // order their first passage appears; within a shelf, arrival order holds.
  const shelves = useMemo(() => {
    const out: { name: string; passages: SearchPassage[] }[] = [];
    const byName = new Map<string, { name: string; passages: SearchPassage[] }>();
    for (const p of passages) {
      const name = shelfFor(p);
      let shelf = byName.get(name);
      if (!shelf) {
        shelf = { name, passages: [] };
        byName.set(name, shelf);
        out.push(shelf);
      }
      shelf.passages.push(p);
    }
    return out;
  }, [passages]);

  const fullTextFor = (p: SearchPassage): string => {
    if (p.type === "verse") {
      const parts: string[] = [];
      if (p.text?.trim()) parts.push(p.text.trim());
      const pur = stripPurportBoilerplate(p.purport || "").trim();
      if (pur) parts.push(pur);
      return parts.join("\n\n");
    }
    return (p.text || "").trim();
  };

  const copyWithRef = async (p: SearchPassage) => {
    const text = fullTextFor(p);
    if (!text) return;
    // The reference always includes the passage's own Vedabase URL when it has one.
    const payload = `"${text}"\n\n— ${citeFor(p)}${p.url ? `\n${p.url}` : ""}`;
    try {
      await navigator.clipboard.writeText(payload);
      setToast("Copied with reference");
    } catch {
      setToast("Copy failed — long-press to copy");
    }
  };

  const jumpNextQuote = () => {
    if (passages.length === 0) return;
    const i = nextIdxRef.current % passages.length;
    nextIdxRef.current = i + 1;
    scrollToSource(passages[i].id);
  };

  if (isLoading) return null;
  if (!results) return null;

  if (results.totalResults === 0) {
    const examples = ["What is the soul?", "How to chant with attention", "Overcoming anger"];
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "clamp(48px,10vw,80px) 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <p className="font-display" style={{ fontSize: "1.4rem", color: "var(--ink)", margin: 0 }}>
          {results.retrievalStatus === "degraded"
            ? "No passages were found in the sources that were available."
            : "No passages found for that phrasing."}
        </p>
        {results.suggestion && results.suggestionDisplay && (
          <p className="font-body" style={{ fontSize: "1rem", color: "var(--ink)", margin: 0 }}>
            Did you mean{" "}
            <button
              className="font-body"
              onClick={() => onSearch(results.suggestion!)}
              style={{ fontSize: "1rem", fontWeight: 600, color: "var(--accent-strong)", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
            >
              {results.suggestionDisplay}
            </button>
            ?
          </p>
        )}
        <p className="font-body" style={{ fontSize: "0.95rem", color: "var(--ink-muted)", maxWidth: 440, lineHeight: 1.6, margin: 0 }}>
          Try rephrasing your question — or a different spelling (Krsna, Krishna, and Kṛṣṇa all work).
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: 8 }}>
          {examples.map((q) => (
            <button key={q} className="font-body" onClick={() => onSearch(q)}
              style={{ fontSize: "0.85rem", fontWeight: 500, color: "var(--accent-strong)", background: "var(--accent-tint)", border: "1px solid transparent", borderRadius: "var(--radius-full)", padding: "8px 16px", cursor: "pointer" }}>
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="results-shell" ref={shellRef}>
        {/* View toggle — quiet, right-aligned */}
        <div className="view-toggle-row">
          <div className="view-mode-toggle" role="tablist" aria-label="Result view">
            <button role="tab" aria-selected={viewMode === "article"} className={`font-body${viewMode === "article" ? " active" : ""}`} onClick={() => onViewModeChange("article")}>Essay</button>
            <button role="tab" aria-selected={viewMode === "references"} className={`font-body${viewMode === "references" ? " active" : ""}`} onClick={() => onViewModeChange("references")}>By source</button>
          </div>
        </div>

        {viewMode === "article" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, ease: EASE.decelerate }}>
            {/* Neutral orientation (subordinate framing — never doctrine) */}
            {results.intro && <p className="framing-note framing-intro font-body">{results.intro}</p>}

            {/* Desktop Contents jump-list — collapsed by default, navigation only */}
            {passages.length > 1 && (
              <details className="contents">
                <summary className="font-body">Contents · {passages.length} passages</summary>
                <ol>
                  {passages.map(p => (
                    <li key={p.id}>
                      <button className="font-body" onClick={() => scrollToSource(p.id)}>{citeFor(p)}</button>
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {/* Every passage, in the reranker's order, words on screen. */}
            <div className="essay-flow">
              {passages.map((p, i) => (
                <PassageCard
                  key={`${results.query}:${p.id}`}
                  p={p} index={i}
                  queryTerms={queryTerms} onCopy={copyWithRef} onOpenPreview={setPreview}
                />
              ))}
            </div>

            {results.totalResults > 0 && <SearchFeedback searchLogId={searchLogId || null} />}
          </motion.div>
        )}

        {viewMode === "references" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, ease: EASE.decelerate }}>
            {shelves.map(shelf => (
              <section key={shelf.name} className="ref-book">
                <h3 className="font-display">{shelf.name}</h3>
                <div className="essay-flow">
                  {shelf.passages.map(p => (
                    <PassageCard
                      key={`${results.query}:ref:${p.id}`}
                      p={p}
                      queryTerms={queryTerms} onCopy={copyWithRef} onOpenPreview={setPreview}
                    />
                  ))}
                </div>
              </section>
            ))}
          </motion.div>
        )}

        {/* Below the main article in either view: everything else the library
            found, grouped by kind, collapsed until asked for. */}
        <AdditionalTier list={results.additional || []} truncated={results.additionalTruncated} />
      </div>

      {/* Mobile floating "next passage" */}
      {passages.length > 2 && (
        <button className="next-quote-btn" onClick={jumpNextQuote} aria-label="Jump to the next passage">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        </button>
      )}

      {/* Citation preview sheet */}
      <AnimatePresence>
        {preview && (
          <PreviewSheet p={preview} onClose={() => setPreview(null)} onCopy={copyWithRef} />
        )}
      </AnimatePresence>

      {/* Copy toast */}
      <AnimatePresence>
        {toast && (
          <motion.div className="copy-toast font-body" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.24, ease: EASE.decelerate }}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <style jsx global>{`
        .results-shell { max-width: 720px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 24px); }

        .view-toggle-row { display: flex; justify-content: flex-end; margin-bottom: var(--space-5); }
        .view-mode-toggle { display: inline-flex; border: 1px solid var(--border-hair); border-radius: var(--radius-full); overflow: hidden; background: var(--surface-raised); }
        .view-mode-toggle button { padding: 7px 16px; font-size: var(--type-label-size); font-weight: 500; border: none; cursor: pointer; background: transparent; color: var(--ink-muted); transition: background var(--dur-2) var(--ease-standard), color var(--dur-2) var(--ease-standard); }
        .view-mode-toggle button.active { background: var(--accent); color: var(--on-accent); }

        /* Neutral AI framing — visually subordinate so it can never read as scripture. */
        .framing-note { font-size: 0.95rem; line-height: 1.6; color: var(--framing); max-width: var(--measure); }
        .framing-intro { margin-bottom: var(--space-7); }

        .contents { margin: 0 0 var(--space-6); border: 1px solid var(--border-hair); border-radius: var(--radius-md); background: var(--surface-raised); }
        .contents > summary { cursor: pointer; padding: 10px 14px; font-size: var(--type-label-size); color: var(--ink-muted); list-style: none; }
        .contents > summary::-webkit-details-marker { display: none; }
        .contents ol { margin: 0; padding: 0 14px 12px 14px; list-style: none; display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
        .contents li button { background: none; border: none; padding: 4px 0; color: var(--accent-strong); font-size: 0.85rem; cursor: pointer; text-align: left; }
        .contents li button:hover { text-decoration: underline; }
        @media (max-width: 900px) { .contents { display: none; } }

        .essay-flow { display: flex; flex-direction: column; }

        .passage { padding: var(--space-6) 0; border-bottom: 1px solid var(--border-hair); }
        .essay-flow .passage:last-child { border-bottom: none; }

        /* Framing the reader must see for letters / recorded exchanges. */
        .context-notice { font-size: 0.82rem; color: var(--ink-muted); font-style: italic; margin: 0 0 var(--space-3); }
        .also-appears { font-size: 0.8rem; color: var(--ink-subtle); margin: var(--space-3) 0 0; }

        /* Source types distinguished by TYPOGRAPHY (no colored bars, no legend). */
        .verse-translation { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1.2rem, 2.4vw, 1.4rem); line-height: 1.45; color: var(--ink-strong); }
        .verse-translation .pp { margin: 0 0 var(--space-3); }
        .verse-translation .pp:last-child { margin-bottom: 0; }

        .passage-body { font-size: var(--type-body-size); line-height: var(--type-body-lh); color: var(--ink); }
        .passage-body .pp { margin: 0 0 var(--space-3); }
        .passage-body .pp:last-child { margin-bottom: 0; }
        .letter-body .passage-body, .passage[data-passage-type="letter"] .passage-body { font-style: italic; }

        /* Purport: subtle indent under its verse (a quiet commentary voice). */
        .purport-block { margin-top: var(--space-4); padding-left: var(--space-4); border-left: 2px solid var(--border-hair); }

        .fold-expand-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: var(--space-3); padding: 4px 0; background: none; border: none; cursor: pointer; font-family: var(--font-body), 'DM Sans', sans-serif; font-size: 0.85rem; font-weight: 600; color: var(--accent-strong); }
        .fold-expand-btn:hover { text-decoration: underline; }

        .passage-foot { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-4); }
        .cite-chip { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-body), 'DM Sans', sans-serif; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.01em; color: var(--accent-strong); background: var(--accent-tint); border: 1px solid transparent; border-radius: var(--radius-full); padding: 3px 11px; cursor: pointer; transition: border-color var(--dur-2) var(--ease-standard); }
        .cite-chip:hover { border-color: var(--accent); }
        .cite-external { padding: 3px 9px; text-decoration: none; }
        .cite-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
        .cite-dot[data-type="lecture"] { background: var(--p-gold); }
        .cite-dot[data-type="letter"] { background: #8AA48F; }
        .copy-chip { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-body), 'DM Sans', sans-serif; font-size: 0.78rem; font-weight: 500; color: var(--ink-muted); background: none; border: none; cursor: pointer; transition: color var(--dur-2) var(--ease-standard); }
        .copy-chip:hover { color: var(--accent-strong); }
        .copy-ico { display: inline-flex; width: 14px; height: 14px; align-items: center; justify-content: center; }
        .cite-chip, .copy-chip { min-height: 30px; }
        .fold-expand-btn:active, .view-mode-toggle button:active { transform: scale(0.985); }

        .ref-book { margin-bottom: var(--space-7); }
        .ref-book h3 { font-size: 1.3rem; font-weight: 600; color: var(--ink-strong); margin: 0 0 var(--space-2); }

        /* ── The second tier: complete, collapsed, citation-weight ── */
        .additional-tier { margin: var(--space-7) 0 0; border: 1px solid var(--border-hair); border-radius: var(--radius-md); background: var(--surface-raised); }
        .additional-tier > summary { cursor: pointer; padding: 12px 16px; font-size: var(--type-label-size); font-weight: 600; color: var(--ink-muted); list-style: none; }
        .additional-tier > summary::-webkit-details-marker { display: none; }
        .additional-tier > summary::before { content: "▸ "; }
        .additional-tier[open] > summary::before { content: "▾ "; }
        .additional-truncated { margin: 0 16px var(--space-3); font-size: 0.8rem; color: var(--ink-subtle); font-style: italic; }
        .additional-group { padding: 0 16px var(--space-4); }
        .additional-group h4 { margin: var(--space-3) 0 var(--space-2); font-size: 0.8rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-subtle); }
        .additional-group ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-3); }
        .additional-label { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 0.82rem; font-weight: 600; color: var(--ink); }
        .additional-label a { color: var(--accent-strong); text-decoration: none; }
        .additional-label a:hover { text-decoration: underline; }
        .additional-snippet { margin: 2px 0 0; font-size: 0.86rem; line-height: 1.55; color: var(--ink-muted); }

        /* ── Matched-sentence emphasis (the bloom): lavender→gold, blooms once,
           then settles to a calm resting tint. Never a flat yellow block. ── */
        mark.hl-sentence, mark.hl-word { color: inherit; }
        .hl-sentence {
          background-image: linear-gradient(90deg, transparent 0%, var(--emphasis-from) 9%, var(--emphasis-to) 91%, transparent 100%);
          background-repeat: no-repeat; background-position: left center;
          background-size: 0% 76%; /* dormant until it enters the viewport */
          border-radius: 7px; padding: 0.04em 0.32em;
          -webkit-box-decoration-break: clone; box-decoration-break: clone;
        }
        /* Blooms once, left→right, holds ~600ms, then eases down to a calm resting tint. */
        .hl-sentence.bloom { animation: hlBloom 1.25s var(--ease-decelerate) forwards; }
        @keyframes hlBloom {
          0%   { background-size: 0% 76%;   box-shadow: 0 1px 12px color-mix(in srgb, var(--accent) 0%, transparent); }
          48%  { background-size: 100% 76%; box-shadow: 0 1px 16px color-mix(in srgb, var(--accent) 20%, transparent); }
          70%  { background-size: 100% 76%; box-shadow: 0 1px 16px color-mix(in srgb, var(--accent) 20%, transparent); }
          100% { background-size: 100% 76%; box-shadow: 0 1px 9px color-mix(in srgb, var(--accent) 6%, transparent); }
        }
        .hl-word { background-image: linear-gradient(transparent 58%, color-mix(in srgb, var(--accent) 22%, transparent) 58%); border-radius: 1px; padding: 0 0.5px; font-weight: 500; color: var(--accent-strong); }

        /* ── Citation preview sheet + scrim ── */
        .sheet-scrim { position: fixed; inset: 0; background: color-mix(in srgb, var(--ink-strong) 32%, transparent); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); z-index: 200; }
        .preview-sheet { position: fixed; z-index: 201; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(640px, 92vw); max-height: 82vh; overflow-y: auto; background: var(--surface-raised); border: 1px solid var(--border-hair); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); padding: var(--space-5); }
        .preview-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-4); }
        .preview-head .cite-chip { cursor: default; }
        .sheet-close { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border-hair); background: transparent; color: var(--ink-muted); font-size: 20px; cursor: pointer; line-height: 1; }
        .preview-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-hair); }
        .preview-actions .copy-chip { font-size: 0.85rem; }
        .vedabase-link { font-size: 0.85rem; font-weight: 600; color: var(--accent-strong); text-decoration: none; }
        .vedabase-link:hover { text-decoration: underline; }
        .preview-links { display: flex; gap: var(--space-4); align-items: center; }
        @media (max-width: 640px) {
          .preview-sheet { left: 0; right: 0; bottom: 0; top: auto; transform: none; width: 100%; max-height: 85vh; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
        }

        /* ── Mobile "next passage" floating button ── */
        .next-quote-btn { position: fixed; right: 16px; bottom: 20px; z-index: 60; width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--border-hair); background: var(--surface-raised); color: var(--accent-strong); box-shadow: var(--shadow-soft); cursor: pointer; display: none; align-items: center; justify-content: center; transition: transform var(--dur-2) var(--ease-standard); }
        .next-quote-btn:active { transform: scale(0.94); }
        @media (max-width: 900px) { .next-quote-btn { display: flex; } }

        .copy-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 210; background: var(--ink-strong); color: var(--surface-raised); font-size: 0.85rem; padding: 10px 18px; border-radius: var(--radius-full); box-shadow: var(--shadow-soft); }

        @media (prefers-reduced-motion: reduce) {
          .hl-sentence.bloom { animation-duration: 0.01ms; }
        }

        @media (max-width: 768px) {
          .passage { padding: var(--space-5) 0; }
        }
      `}</style>
    </MotionConfig>
  );
}
