/**
 * 01-narrative-response.tsx — Woven Essay (sacred-minimalism reading surface)
 *
 * A single-column, scan-then-read-deep reading surface. Neutral AI framing
 * (small, muted) opens and closes; the 2–3 strongest passages are elevated as
 * hero cards; the remaining main-flow passages flow as the woven essay, each
 * collapsed to its strongest line and expandable in place. Every passage keeps
 * a quiet tappable citation chip and a "Copy with reference" action. Overflow
 * lives in the Dig Deeper sheet — nothing is ever removed.
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
import DigDeeperModal from "./02-dig-deeper-modal";
import {
  buildFoldPreviewHtml,
  highlightParagraphsHtml,
  buildSectionText,
  type PassageType,
} from "@/app/lib/10-passage-fold";
import { stripPurportBoilerplate, escapeHtml } from "@/app/lib/09-purport-format";
import { EASE, SPRING_SETTLE } from "@/app/lib/11-motion";
import {
  type PassageLabel,
  formatLabel,
  labelForVerse,
  labelForPurport,
  labelForProse,
  labelForTranscript,
  labelForLetter,
} from "@/app/lib/13-passage-label";

/* ─────────────────────────── Data contract ───────────────────────────
   The response types live in the shared server↔client contract
   (app/lib/types/01-search.ts) and are re-exported here so existing
   importers (e.g. 02-dig-deeper-modal) keep working unchanged. */

import type {
  Citation,
  VerseHit,
  ProseHit,
  TranscriptHit,
  LetterHit,
  KeyAnswer,
  BookGroup,
  MainFlowNode,
  SearchResults,
} from "@/app/lib/types/01-search";

export type {
  Citation,
  VerseHit,
  ProseHit,
  TranscriptHit,
  LetterHit,
  KeyAnswer,
  BookGroup,
  MainFlowNode,
  SearchResults,
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

// A verse reference built on the client (References mode), mirroring the server's cleanRef.
function verseRef(v: VerseHit): string {
  const num = (v.verse_number || "").replace(/^Text\s+/i, "");
  return `${v.scripture || ""} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${num}`.trim();
}

function scrollToSource(id: string) {
  document.getElementById(`source-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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

/* ─────────────────────────── Attribution label line ─────────────────────────── */

type AnyHit = VerseHit | ProseHit | TranscriptHit | LetterHit;

// TYPE + SOURCE + SPEAKER metadata, computed from the hit itself (13-passage-label)
// so the essay, references mode, and preview sheet all label identically.
function labelFor(type: MainFlowNode["type"], data: AnyHit): PassageLabel {
  switch (type) {
    case "verse": return labelForVerse(data as VerseHit);
    case "prose": return labelForProse(data as ProseHit);
    case "lecture": return labelForTranscript(data as TranscriptHit);
    case "letter": return labelForLetter(data as LetterHit);
  }
}

function LabelLine({ type, data }: { type: MainFlowNode["type"]; data: AnyHit }) {
  const label = labelFor(type, data);
  const text = formatLabel(label);
  if (!text && !label.provenanceNote) return null;
  return (
    <div className="passage-label">
      {text && <span>{text}</span>}
      {label.provenanceNote && <span className="passage-label-note">{label.provenanceNote}</span>}
    </div>
  );
}

/* ─────────────────────────── One passage card ─────────────────────────── */

function PassageCard({
  node, data, hero, line, index = 0, queryTerms, onCopy, onOpenPreview,
}: {
  node: MainFlowNode;
  data: AnyHit;
  hero?: boolean;
  line?: string;
  index?: number;
  queryTerms: string[];
  onCopy: (node: MainFlowNode) => void;
  onOpenPreview: (node: MainFlowNode) => void;
}) {
  const [open, setOpen] = useState(false);
  // Compose-in: only the first ~10 passages stagger; the rest appear at once.
  const entranceDelay = index < 10 ? index * 0.07 : 0;

  const foot = (
    <div className="passage-foot">
      <motion.button className="cite-chip" onClick={() => onOpenPreview(node)} whileTap={{ scale: 0.97 }} aria-label={`Preview ${formatCiteRef(node.ref)}`}>
        <span className="cite-dot" data-type={node.type} aria-hidden />
        {formatCiteRef(node.ref)}
      </motion.button>
      {node.url && (
        <a
          className="cite-chip cite-external"
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${formatCiteRef(node.ref)} on Vedabase in a new tab`}
        >
          ↗
        </a>
      )}
      <CopyButton onCopy={() => onCopy(node)} />
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

  if (node.type === "verse") {
    const v = data as VerseHit;
    const translationHtml = highlightParagraphsHtml(v.translation || "", undefined, queryTerms);
    const purport = (v.purport || "").trim();
    const preview = purport ? buildFoldPreviewHtml({ type: "purport", text: v.purport || "", matchedChunkText: v.matchedChunkText, queryTerms }) : null;
    const purportFull = purport ? highlightParagraphsHtml(v.purport || "", v.matchedChunkText, queryTerms) : "";
    content = (
      <>
        <div className={hero ? "verse-translation hero" : "verse-translation"} dangerouslySetInnerHTML={{ __html: translationHtml }} />
        {preview && preview.previewHtml && (
          <div className="purport-block">
            <div className="passage-label">
              <span>{formatLabel(labelForPurport(v))}</span>
            </div>
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
    const d = data as ProseHit | TranscriptHit | LetterHit;
    const body = d.body_text || "";
    const preview = buildFoldPreviewHtml({ type: node.type as PassageType, text: body, queryTerms });
    const sectionFull = highlightParagraphsHtml(buildSectionText(body, d.before, d.after), undefined, queryTerms, node.type as PassageType);
    if (hero) {
      content = (
        <>
          {line && <p className="hero-quote"><span className="hl-sentence">{line}</span></p>}
          {full(sectionFull)}
          {(preview.truncated || !open) && (
            <button className="fold-expand-btn" onClick={() => setOpen(o => !o)}>
              {open ? "Show less ↑" : "Read in context ↓"}
            </button>
          )}
        </>
      );
    } else {
      content = (
        <div className={node.type === "letter" ? "letter-body" : undefined}>
          {!open && <div className="passage-body" dangerouslySetInnerHTML={{ __html: preview.previewHtml }} />}
          {full(sectionFull)}
          {preview.truncated && (
            <button className="fold-expand-btn" onClick={() => setOpen(o => !o)}>
              {open ? "Show less ↑" : "Read in context ↓"}
            </button>
          )}
        </div>
      );
    }
  }

  return (
    <motion.article
      id={`source-${node.id}`}
      className={`passage${hero ? " passage-hero" : ""}`}
      data-passage-type={node.type}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE.decelerate, delay: entranceDelay }}
    >
      <LabelLine type={node.type} data={data} />
      {content}
      {foot}
    </motion.article>
  );
}

/* ─────────────────────────── Citation preview sheet ─────────────────────────── */

function PreviewSheet({
  node, data, onClose, onCopy,
}: {
  node: MainFlowNode;
  data: AnyHit;
  onClose: () => void;
  onCopy: (node: MainFlowNode) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  let html = "";
  if (node.type === "verse") {
    const v = data as VerseHit;
    const parts: string[] = [];
    if (v.translation?.trim()) parts.push(highlightParagraphsHtml(v.translation, undefined, []));
    if ((v.purport || "").trim()) {
      parts.push(`<div class="passage-label">${escapeHtml(formatLabel(labelForPurport(v)))}</div>`);
      parts.push(highlightParagraphsHtml(v.purport, undefined, []));
    }
    html = parts.join("");
  } else {
    const d = data as ProseHit | TranscriptHit | LetterHit;
    html = highlightParagraphsHtml(buildSectionText(d.body_text || "", d.before, d.after), undefined, [], node.type as PassageType);
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
        role="dialog" aria-label={`${formatCiteRef(node.ref)} full passage`}
        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
        transition={{ duration: 0.28, ease: EASE.decelerate }}
      >
        <div className="preview-head">
          <span className="cite-chip" aria-hidden><span className="cite-dot" data-type={node.type} />{formatCiteRef(node.ref)}</span>
          <button className="sheet-close" onClick={onClose} aria-label="Close preview">&times;</button>
        </div>
        <LabelLine type={node.type} data={data} />
        <div className="preview-body passage-body" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="preview-actions">
          <CopyButton onCopy={() => onCopy(node)} label="Copy with reference" />
          <span className="preview-links">
            {node.type === "verse" && (
              <Link className="vedabase-link" href={`/verse/${node.id}`}>Read this verse →</Link>
            )}
            {node.url && (
              <a className="vedabase-link" href={node.url} target="_blank" rel="noopener noreferrer">Open in Vedabase ↗</a>
            )}
          </span>
        </div>
      </motion.div>
    </>
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
  const [digDeeperOpen, setDigDeeperOpen] = useState(false);
  const [previewNode, setPreviewNode] = useState<MainFlowNode | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const nextIdxRef = useRef(0);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setDigDeeperOpen(false); setPreviewNode(null); }, [results?.query]);
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

  const queryTerms = results?.queryTerms || [];

  // id → passage data, across the main set and overflow (lossless client lookup).
  const maps = useMemo(() => {
    const verse = new Map<string, VerseHit>();
    const prose = new Map<string, ProseHit>();
    const lecture = new Map<string, TranscriptHit>();
    const letter = new Map<string, LetterHit>();
    if (results) {
      for (const b of results.books) {
        for (const v of b.verses) verse.set(v.id, v);
        for (const p of b.prose) prose.set(p.id, p);
        for (const t of (b.transcripts || [])) lecture.set(t.id, t);
        for (const l of (b.letters || [])) letter.set(l.id, l);
      }
      for (const v of (results.overflowVerses || [])) if (!verse.has(v.id)) verse.set(v.id, v);
      for (const p of (results.overflowProse || [])) if (!prose.has(p.id)) prose.set(p.id, p);
      for (const t of (results.overflowTranscripts || [])) if (!lecture.has(t.id)) lecture.set(t.id, t);
      for (const l of (results.overflowLetters || [])) if (!letter.has(l.id)) letter.set(l.id, l);
    }
    return { verse, prose, lecture, letter };
  }, [results]);

  const dataFor = (node: MainFlowNode): AnyHit | undefined => {
    if (node.type === "verse") return maps.verse.get(node.id);
    if (node.type === "prose") return maps.prose.get(node.id);
    if (node.type === "lecture") return maps.lecture.get(node.id);
    return maps.letter.get(node.id);
  };

  const mainFlow = results?.mainFlowItems || [];
  const keyAnswers = results?.keyAnswers || [];

  // Heroes: the top 2–3 substantive matched lines (never a bare fragment — the
  // server already filtered empties out of keyAnswers).
  const heroes = useMemo(() => {
    const out: { node: MainFlowNode; line: string }[] = [];
    for (const ka of keyAnswers) {
      const node = mainFlow.find(n => n.id === ka.id);
      if (node && dataFor(node)) out.push({ node, line: ka.line });
      if (out.length >= 3) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyAnswers, mainFlow, maps]);

  const heroIds = new Set(heroes.map(h => h.node.id));
  const essayNodes = mainFlow.filter(n => !heroIds.has(n.id));

  const fullTextFor = (node: MainFlowNode): string => {
    const d = dataFor(node);
    if (!d) return "";
    if (node.type === "verse") {
      const v = d as VerseHit;
      const parts: string[] = [];
      if (v.translation?.trim()) parts.push(v.translation.trim());
      const pur = stripPurportBoilerplate(v.purport || "").trim();
      if (pur) parts.push(pur);
      return parts.join("\n\n");
    }
    const s = d as ProseHit | TranscriptHit | LetterHit;
    return buildSectionText(s.body_text || "", s.before, s.after);
  };

  const copyWithRef = async (node: MainFlowNode) => {
    const text = fullTextFor(node);
    if (!text) return;
    // The reference always includes the passage's own Vedabase URL when it has one.
    const payload = `"${text}"\n\n— ${formatCiteRef(node.ref)}${node.url ? `\n${node.url}` : ""}`;
    try {
      await navigator.clipboard.writeText(payload);
      setToast("Copied with reference");
    } catch {
      setToast("Copy failed — long-press to copy");
    }
  };

  const jumpNextQuote = () => {
    const anchors = [...heroes.map(h => h.node.id), ...essayNodes.map(n => n.id)];
    if (anchors.length === 0) return;
    const i = nextIdxRef.current % anchors.length;
    nextIdxRef.current = i + 1;
    scrollToSource(anchors[i]);
  };

  if (isLoading) return null;
  if (!results) return null;

  if (results.totalResults === 0) {
    const examples = ["What is the soul?", "How to chant with attention", "Overcoming anger"];
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "clamp(48px,10vw,80px) 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <p className="font-display" style={{ fontSize: "1.4rem", color: "var(--ink)", margin: 0 }}>No passages found for that phrasing.</p>
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

  const overflowTotal =
    (results.overflowVerses?.length || 0) + (results.overflowProse?.length || 0) +
    (results.overflowTranscripts?.length || 0) + (results.overflowLetters?.length || 0);
  const hasDigDeeper =
    ((results.totalVerses || 0) + (results.totalProse || 0) + (results.totalTranscripts || 0) + (results.totalLetters || 0)) > 25 &&
    overflowTotal > 0;

  // References: grouped by book, rendered with the SAME passage cards.
  const referenceBooks = results.books.filter(
    b => b.verses.length > 0 || b.prose.length > 0 || (b.transcripts?.length || 0) > 0 || (b.letters?.length || 0) > 0,
  );

  const digDeeperBtn = hasDigDeeper && (
    <button onClick={() => setDigDeeperOpen(true)} className="dig-deeper-btn font-body">
      Dig deeper — {overflowTotal} more {overflowTotal === 1 ? "passage" : "passages"} ↓
    </button>
  );

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
            {mainFlow.length > 1 && (
              <details className="contents">
                <summary className="font-body">Contents · {mainFlow.length} passages</summary>
                <ol>
                  {mainFlow.map(n => (
                    <li key={n.id}>
                      <button className="font-body" onClick={() => scrollToSource(n.id)}>{formatCiteRef(n.ref)}</button>
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {/* Hero passages */}
            {heroes.length > 0 && (
              <div className="hero-stack">
                {heroes.map((h, hi) => {
                  const d = dataFor(h.node);
                  if (!d) return null;
                  return (
                    <PassageCard
                      key={`${results.query}:${h.node.id}`}
                      node={h.node} data={d} hero line={h.line} index={hi}
                      queryTerms={queryTerms} onCopy={copyWithRef} onOpenPreview={setPreviewNode}
                    />
                  );
                })}
              </div>
            )}

            {/* Woven essay — the remaining main-flow passages, most-important-first */}
            <div className="essay-flow">
              {essayNodes.map((node, j) => {
                const d = dataFor(node);
                if (!d) return null;
                return (
                  <PassageCard
                    key={`${results.query}:${node.id}`}
                    node={node} data={d} index={heroes.length + j}
                    queryTerms={queryTerms} onCopy={copyWithRef} onOpenPreview={setPreviewNode}
                  />
                );
              })}
            </div>

            {/* Neutral conclusion */}
            {results.conclusion && <p className="framing-note framing-outro font-body">{results.conclusion}</p>}

            {/* Fallback: if structured items are unavailable, show the verbatim essay HTML. */}
            {mainFlow.length === 0 && results.narrative && (
              <div className="narrative-content font-body" dangerouslySetInnerHTML={{ __html: results.narrative }} />
            )}

            {results.totalResults > 0 && <SearchFeedback searchLogId={searchLogId || null} />}
            {digDeeperBtn}
          </motion.div>
        )}

        {viewMode === "references" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, ease: EASE.decelerate }}>
            {referenceBooks.map(book => {
              const nodes: { node: MainFlowNode; data: AnyHit }[] = [
                ...book.verses.map(v => ({ node: { type: "verse" as const, id: v.id, ref: verseRef(v), url: v.vedabase_url || "" }, data: v as AnyHit })),
                ...book.prose.map(p => ({ node: { type: "prose" as const, id: p.id, ref: book.name, url: p.vedabase_url || "" }, data: p as AnyHit })),
                ...(book.transcripts || []).map(t => ({ node: { type: "lecture" as const, id: t.id, ref: ["Lecture", t.date ? new Date(t.date).getFullYear().toString() : "", t.location].filter(Boolean).join(" · "), url: t.vedabase_url || "" }, data: t as AnyHit })),
                ...(book.letters || []).map(l => ({ node: { type: "letter" as const, id: l.id, ref: ["Letter", l.recipient ? `to ${l.recipient}` : "", l.date ? new Date(l.date).getFullYear().toString() : ""].filter(Boolean).join(" · "), url: l.vedabase_url || "" }, data: l as AnyHit })),
              ];
              return (
                <section key={book.slug} className="ref-book">
                  <h3 className="font-display">{book.name}</h3>
                  <div className="essay-flow">
                    {nodes.map(({ node, data }) => (
                      <PassageCard
                        key={`${results.query}:ref:${node.id}`}
                        node={node} data={data}
                        queryTerms={queryTerms} onCopy={copyWithRef} onOpenPreview={setPreviewNode}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {digDeeperBtn}
          </motion.div>
        )}
      </div>

      {/* Mobile floating "next strong quote" */}
      {heroes.length + essayNodes.length > 2 && (
        <button className="next-quote-btn" onClick={jumpNextQuote} aria-label="Jump to the next quote">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        </button>
      )}

      {/* Citation preview sheet */}
      <AnimatePresence>
        {previewNode && dataFor(previewNode) && (
          <PreviewSheet
            node={previewNode}
            data={dataFor(previewNode) as AnyHit}
            onClose={() => setPreviewNode(null)}
            onCopy={copyWithRef}
          />
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

      {/* Dig deeper */}
      {digDeeperOpen && (
        <DigDeeperModal
          overflowVerses={results.overflowVerses || []}
          overflowProse={results.overflowProse || []}
          overflowTranscripts={results.overflowTranscripts || []}
          overflowLetters={results.overflowLetters || []}
          totalVerses={results.totalVerses || 0}
          totalProse={results.totalProse || 0}
          totalTranscripts={results.totalTranscripts || 0}
          totalLetters={results.totalLetters || 0}
          articleVerseIds={new Set(results.articleVerseIds || [])}
          onClose={() => setDigDeeperOpen(false)}
        />
      )}

      <style jsx global>{`
        .results-shell { max-width: 720px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 24px); }

        .view-toggle-row { display: flex; justify-content: flex-end; margin-bottom: var(--space-5); }
        .view-mode-toggle { display: inline-flex; border: 1px solid var(--border-hair); border-radius: var(--radius-full); overflow: hidden; background: var(--surface-raised); }
        .view-mode-toggle button { padding: 7px 16px; font-size: var(--type-label-size); font-weight: 500; border: none; cursor: pointer; background: transparent; color: var(--ink-muted); transition: background var(--dur-2) var(--ease-standard), color var(--dur-2) var(--ease-standard); }
        .view-mode-toggle button.active { background: var(--accent); color: var(--on-accent); }

        /* Neutral AI framing — visually subordinate so it can never read as scripture. */
        .framing-note { font-size: 0.95rem; line-height: 1.6; color: var(--framing); max-width: var(--measure); }
        .framing-intro { margin-bottom: var(--space-7); }
        .framing-outro { margin-top: var(--space-7); padding-top: var(--space-4); border-top: 1px solid var(--border-hair); }

        .contents { margin: 0 0 var(--space-6); border: 1px solid var(--border-hair); border-radius: var(--radius-md); background: var(--surface-raised); }
        .contents > summary { cursor: pointer; padding: 10px 14px; font-size: var(--type-label-size); color: var(--ink-muted); list-style: none; }
        .contents > summary::-webkit-details-marker { display: none; }
        .contents ol { margin: 0; padding: 0 14px 12px 14px; list-style: none; display: flex; flex-direction: column; gap: 2px; }
        .contents li button { background: none; border: none; padding: 4px 0; color: var(--accent-strong); font-size: 0.85rem; cursor: pointer; text-align: left; }
        .contents li button:hover { text-decoration: underline; }
        @media (max-width: 900px) { .contents { display: none; } }

        .hero-stack { display: flex; flex-direction: column; gap: var(--space-5); margin-bottom: var(--space-7); }
        .essay-flow { display: flex; flex-direction: column; }

        .passage { padding: var(--space-6) 0; border-bottom: 1px solid var(--border-hair); }
        .essay-flow .passage:last-child { border-bottom: none; }
        .passage-hero { padding: var(--space-6); background: var(--surface-raised); border: 1px solid var(--border-hair); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); }

        /* Source types distinguished by TYPOGRAPHY (no colored bars, no legend). */
        .verse-translation { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1.2rem, 2.4vw, 1.4rem); line-height: 1.45; color: var(--ink-strong); }
        .verse-translation.hero { font-size: clamp(1.35rem, 3vw, 1.7rem); }
        .verse-translation .pp { margin: 0 0 var(--space-3); }
        .verse-translation .pp:last-child { margin-bottom: 0; }

        .hero-quote { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1.35rem, 3vw, 1.7rem); line-height: 1.4; color: var(--ink-strong); }

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
        .fold-expand-btn:active, .dig-deeper-btn:active, .view-mode-toggle button:active { transform: scale(0.985); }

        .ref-book { margin-bottom: var(--space-7); }
        .ref-book h3 { font-size: 1.3rem; font-weight: 600; color: var(--ink-strong); margin: 0 0 var(--space-2); }

        .dig-deeper-btn { width: 100%; margin-top: var(--space-6); padding: 14px 20px; border-radius: var(--radius-md); border: 1px dashed var(--border-firm); background: color-mix(in srgb, var(--accent) 4%, transparent); font-size: 0.9rem; font-weight: 600; color: var(--accent-strong); cursor: pointer; text-align: center; transition: background var(--dur-3) var(--ease-standard), border-color var(--dur-3) var(--ease-standard); }
        .dig-deeper-btn:hover { background: color-mix(in srgb, var(--accent) 9%, transparent); border-color: var(--accent); }

        .zero-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-8) var(--space-5); text-align: center; }
        .zero-title { font-size: 1.3rem; color: var(--ink); }
        .zero-hint { font-size: 0.95rem; color: var(--ink-muted); }

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

        /* ── Mobile "next strong quote" floating button ── */
        .next-quote-btn { position: fixed; right: 16px; bottom: 20px; z-index: 60; width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--border-hair); background: var(--surface-raised); color: var(--accent-strong); box-shadow: var(--shadow-soft); cursor: pointer; display: none; align-items: center; justify-content: center; transition: transform var(--dur-2) var(--ease-standard); }
        .next-quote-btn:active { transform: scale(0.94); }
        @media (max-width: 900px) { .next-quote-btn { display: flex; } }

        .copy-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 210; background: var(--ink-strong); color: var(--surface-raised); font-size: 0.85rem; padding: 10px 18px; border-radius: var(--radius-full); box-shadow: var(--shadow-soft); }

        @media (prefers-reduced-motion: reduce) {
          .hl-sentence.bloom { animation-duration: 0.01ms; }
        }

        @media (max-width: 768px) {
          .passage, .passage-hero { padding: var(--space-5) 0; }
          .passage-hero { padding: var(--space-5); }
        }
      `}</style>
    </MotionConfig>
  );
}
