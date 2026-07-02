/**
 * 01-verse-view.tsx — Interactive verse reader (client)
 *
 * Renders the canonical VedaBase hierarchy (citation → Devanāgarī → IAST
 * transliteration → word-for-word synonyms → translation → purport) with each
 * layer independently toggleable. Supports swipe / arrow navigation to the
 * previous & next verse, an "Open in Vedabase" link, and inline cross-reference
 * previews. The static shell is server-rendered by the parent RSC; this child
 * owns only the interactions. Verbatim text is never altered.
 */
"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { EASE } from "@/app/lib/11-motion";
import { type Authorship, authorshipFor, provenanceNoteFor } from "@/app/lib/12-provenance";

export interface VerseData {
  id: string;
  scripture: string;
  verse_number: string;
  sanskrit_devanagari: string;
  transliteration: string;
  synonyms: string;
  translation: string;
  purport: string;
  vedabase_url?: string;
  chapter_id?: string;
  chapters?: {
    chapter_number: string;
    canto_or_division: string;
    chapter_title: string;
    scripture: string;
  };
}

interface Props {
  verse: VerseData;
  prevId: string | null;
  nextId: string | null;
  scriptureName: string;
  authorship?: Authorship;
  provenanceNote?: string;
}

const REF_RE = /\[?\b(BG|SB|CC|NOI|ISO|BS)\s+((?:Ādi|Adi|Madhya|Antya|\d+)[.\s])?(\d+)[.\s](\d+(?:[–-]\d+)?)\]?/g;

type Layer = "deva" | "syn" | "trans" | "purport";

export default function VerseView({ verse, prevId, nextId, scriptureName, authorship, provenanceNote }: Props) {
  const router = useRouter();
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ deva: true, syn: true, trans: true, purport: true });
  const [xref, setXref] = useState<{ loading: boolean; verse: VerseData | null; ref: string } | null>(null);
  const touchX = useRef<number | null>(null);

  const chapter = verse.chapters;
  const cantoPrefix = chapter?.canto_or_division ? `${chapter.canto_or_division}.` : "";
  const chapterNum = chapter?.chapter_number || "";
  const chapterTitle = chapter?.chapter_title || "";

  const synonymEntries = verse.synonyms
    ? verse.synonyms.split(";").map((entry) => {
        const em = entry.trim().split("—");
        if (em.length >= 2) return { term: em[0].trim(), meaning: em.slice(1).join("—").trim() };
        const dash = entry.trim().split("-");
        if (dash.length >= 2) return { term: dash[0].trim(), meaning: dash.slice(1).join("-").trim() };
        return { term: entry.trim(), meaning: "" };
      }).filter((e) => e.term)
    : [];

  const go = (targetId: string | null) => { if (targetId) router.push(`/verse/${targetId}`); };

  const onTouchStart = (e: React.TouchEvent) => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) < 60) return;
    if (dx < 0) go(nextId); else go(prevId);
  };

  const openXref = async (ref: string) => {
    setXref({ loading: true, verse: null, ref });
    try {
      const r = await fetch(`/api/verse?ref=${encodeURIComponent(ref)}`);
      setXref({ loading: false, verse: r.ok ? await r.json() : null, ref });
    } catch {
      setXref({ loading: false, verse: null, ref });
    }
  };

  const withRefs = (text: string): ReactNode[] => {
    const out: ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const refText = m[0].replace(/[[\]]/g, "").trim();
      out.push(
        <button key={`${m.index}-${refText}`} type="button" className="xref" onClick={() => openXref(refText)}>{refText}</button>,
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const toggle = (l: Layer) => setLayers((s) => ({ ...s, [l]: !s[l] }));
  const LAYER_LABELS: [Layer, string][] = [["deva", "Devanāgarī"], ["syn", "Synonyms"], ["trans", "Translation"], ["purport", "Purport"]];

  return (
    <div className="verse-page" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="verse-wrap">
        {/* Top bar: back + prev/next */}
        <div className="verse-bar">
          <Link href="/" className="verse-back">← Back</Link>
          <div className="verse-nav">
            <button type="button" onClick={() => go(prevId)} disabled={!prevId} aria-label="Previous verse">←</button>
            <button type="button" onClick={() => go(nextId)} disabled={!nextId} aria-label="Next verse">→</button>
          </div>
        </div>

        {/* Layer toggles */}
        <div className="layer-toggles" role="group" aria-label="Show or hide layers">
          {LAYER_LABELS.map(([key, label]) => (
            <button key={key} type="button" className={`layer-chip${layers[key] ? " on" : ""}`} aria-pressed={layers[key]} onClick={() => toggle(key)}>
              {label}
            </button>
          ))}
        </div>

        <motion.article
          key={verse.id}
          className="verse-card"
          initial={{ opacity: 0, y: 12, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.4, ease: EASE.decelerate }}
        >
          <div className="verse-scripture">{scriptureName}</div>
          <h1 className="verse-citation">Chapter {cantoPrefix}{chapterNum}, Verse {verse.verse_number}</h1>
          {chapterTitle && <p className="verse-chapter-title">{chapterTitle}</p>}
          {provenanceNote && <p className="verse-provenance">{provenanceNote}</p>}

          {layers.deva && verse.sanskrit_devanagari && (
            <p className="verse-deva font-deva">{verse.sanskrit_devanagari}</p>
          )}

          {layers.deva && verse.transliteration && (
            <p className="verse-translit iast">{verse.transliteration}</p>
          )}

          {layers.syn && synonymEntries.length > 0 && (
            <section className="verse-section">
              <SectionLabel text="Synonyms" />
              <div className="synonyms">
                {synonymEntries.map((entry, i) => (
                  <span key={i} className="syn-entry">
                    <Link className="syn-term font-deva" href={`/?q=${encodeURIComponent(entry.term)}`}>{entry.term}</Link>
                    {entry.meaning && <span className="syn-gloss"> — {entry.meaning}</span>}
                    {i < synonymEntries.length - 1 && <span className="syn-sep">; </span>}
                  </span>
                ))}
              </div>
            </section>
          )}

          {layers.trans && verse.translation && (
            <section className="verse-section">
              <SectionLabel text="Translation" />
              <p className="verse-translation">{withRefs(verse.translation)}</p>
            </section>
          )}

          {layers.purport && verse.purport && (
            <section className="verse-section">
              <SectionLabel text={authorship === "HIS" ? "Purport · Śrīla Prabhupāda" : "Purport"} />
              <div className="verse-purport">
                {verse.purport.split("\n").map((para, i) =>
                  para.trim() ? <p key={i}>{withRefs(para)}</p> : null,
                )}
              </div>
            </section>
          )}

          {verse.vedabase_url && (
            <a className="verse-vedabase" href={verse.vedabase_url} target="_blank" rel="noopener noreferrer">Open in Vedabase ↗</a>
          )}
        </motion.article>

        {/* Prev/next footer */}
        <div className="verse-foot-nav">
          <button type="button" onClick={() => go(prevId)} disabled={!prevId}>← Previous verse</button>
          <button type="button" onClick={() => go(nextId)} disabled={!nextId}>Next verse →</button>
        </div>
      </div>

      {/* Cross-reference preview */}
      <AnimatePresence>
        {xref && (
          <>
            <motion.div className="xref-scrim" onClick={() => setXref(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            <motion.div className="xref-sheet" role="dialog" aria-label={`${xref.ref} preview`}
              initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={{ duration: 0.28, ease: EASE.decelerate }}>
              <div className="xref-head">
                <span className="xref-chip">{xref.ref}</span>
                <button className="xref-close" onClick={() => setXref(null)} aria-label="Close preview">&times;</button>
              </div>
              {xref.loading ? (
                <p className="xref-muted">Loading…</p>
              ) : xref.verse ? (
                <>
                  <XrefLabel verse={xref.verse} />
                  {xref.verse.translation && <p className="xref-translation">{xref.verse.translation}</p>}
                  <div className="xref-actions">
                    <Link className="verse-vedabase" href={`/verse/${xref.verse.id}`} onClick={() => setXref(null)}>Read this verse →</Link>
                    {xref.verse.vedabase_url && <a className="verse-vedabase" href={xref.verse.vedabase_url} target="_blank" rel="noopener noreferrer">Open in Vedabase ↗</a>}
                  </div>
                </>
              ) : (
                <p className="xref-muted">Couldn&rsquo;t load that reference.</p>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <style jsx>{`
        .verse-page { min-height: 100vh; }
        .verse-wrap { max-width: 680px; margin: 0 auto; padding: 96px clamp(20px, 4vw, 40px) 80px; }
        .verse-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
        .verse-back { font-family: var(--font-body), sans-serif; font-size: 14px; font-weight: 500; color: var(--accent-strong); text-decoration: none; }
        .verse-back:hover { text-decoration: underline; }
        .verse-nav { display: flex; gap: 8px; }
        .verse-nav button { width: 40px; height: 40px; border-radius: var(--radius-full); border: 1px solid var(--border-hair); background: var(--surface-raised); color: var(--ink-muted); cursor: pointer; font-size: 16px; transition: border-color var(--dur-2) var(--ease-standard), color var(--dur-2) var(--ease-standard); }
        .verse-nav button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-strong); }
        .verse-nav button:disabled { opacity: 0.35; cursor: default; }

        .layer-toggles { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
        .layer-chip { font-family: var(--font-body), sans-serif; font-size: 0.8rem; font-weight: 500; padding: 6px 14px; min-height: 34px; border-radius: var(--radius-full); border: 1px solid var(--border-hair); background: var(--surface-raised); color: var(--ink-subtle); cursor: pointer; transition: all var(--dur-2) var(--ease-standard); }
        .layer-chip.on { background: var(--accent-tint); border-color: transparent; color: var(--accent-strong); }
        .layer-chip:active { transform: scale(0.97); }

        .verse-card { background: var(--surface-raised); border: 1px solid var(--border-hair); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); padding: clamp(24px, 4vw, 40px); }
        .verse-scripture { font-family: var(--font-body), sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-subtle); text-align: center; margin-bottom: 10px; }
        .verse-citation { font-family: var(--font-display), Georgia, serif; font-size: clamp(1.5rem, 3.4vw, 1.9rem); font-weight: 600; color: var(--ink-strong); text-align: center; letter-spacing: -0.01em; margin: 0; }
        .verse-chapter-title { font-family: var(--font-display), Georgia, serif; font-size: 1.05rem; font-style: italic; color: var(--ink-muted); text-align: center; margin: 6px 0 0; }
        .verse-provenance { font-family: var(--font-body), sans-serif; font-size: 12px; font-style: italic; color: var(--ink-subtle); text-align: center; margin: 8px 0 0; }

        .verse-deva { font-size: 1.2rem; line-height: 2; font-weight: 500; color: var(--ink-strong); text-align: center; margin: 28px 0 0; }
        .verse-translit { font-family: var(--font-display), Georgia, serif; font-size: 1.05rem; color: var(--ink-muted); line-height: 1.8; text-align: center; margin: 12px 0 0; }

        .verse-section { margin-top: 32px; }
        .synonyms { margin-top: 12px; font-size: 0.95rem; line-height: 1.9; color: var(--ink-muted); }
        .syn-term { font-size: 0.95rem; font-weight: 600; color: var(--accent-strong); text-decoration: none; }
        .syn-term:hover { text-decoration: underline; }
        .syn-gloss { color: var(--ink-muted); }
        .syn-sep { color: var(--ink-subtle); }

        .verse-translation { font-family: var(--font-display), Georgia, serif; font-size: 1.25rem; font-weight: 600; line-height: 1.55; color: var(--ink-strong); margin-top: 12px; }
        .verse-purport { margin-top: 12px; font-size: var(--type-body-size); line-height: 1.75; color: var(--ink); }
        .verse-purport p { margin: 0 0 16px; }
        .verse-purport p:last-child { margin-bottom: 0; }

        .xref { display: inline; background: none; border: none; padding: 0; font: inherit; color: var(--accent-strong); font-weight: 600; cursor: pointer; }
        .xref:hover { text-decoration: underline; }

        .verse-vedabase { display: inline-block; margin-top: 24px; font-family: var(--font-body), sans-serif; font-size: 0.9rem; font-weight: 600; color: var(--accent-strong); text-decoration: none; }
        .verse-vedabase:hover { text-decoration: underline; }

        .verse-foot-nav { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 24px; }
        .verse-foot-nav button { font-family: var(--font-body), sans-serif; font-size: 0.85rem; font-weight: 500; color: var(--ink-muted); background: none; border: none; cursor: pointer; padding: 8px 0; }
        .verse-foot-nav button:hover:not(:disabled) { color: var(--accent-strong); }
        .verse-foot-nav button:disabled { opacity: 0.35; cursor: default; }

        .xref-scrim { position: fixed; inset: 0; z-index: 200; background: color-mix(in srgb, var(--ink-strong) 32%, transparent); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
        .xref-sheet { position: fixed; z-index: 201; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, 92vw); max-height: 80vh; overflow-y: auto; background: var(--surface-raised); border: 1px solid var(--border-hair); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); padding: var(--space-5); }
        .xref-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-4); }
        .xref-chip { font-family: var(--font-body), sans-serif; font-size: 0.78rem; font-weight: 600; color: var(--accent-strong); background: var(--accent-tint); padding: 3px 11px; border-radius: var(--radius-full); }
        .xref-close { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border-hair); background: transparent; color: var(--ink-muted); font-size: 20px; cursor: pointer; line-height: 1; }
        .xref-translation { font-family: var(--font-display), Georgia, serif; font-size: 1.15rem; line-height: 1.5; color: var(--ink-strong); margin: 0; }
        .xref-actions { display: flex; gap: var(--space-4); margin-top: var(--space-4); }
        .xref-actions .verse-vedabase { margin-top: 0; }
        .xref-muted { color: var(--ink-muted); font-size: 0.95rem; }
        @media (max-width: 640px) {
          .xref-sheet { left: 0; right: 0; bottom: 0; top: auto; transform: none; width: 100%; max-height: 85vh; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
        }
      `}</style>
    </div>
  );
}

/** Quiet TYPE + provenance line for the cross-reference preview sheet. */
function XrefLabel({ verse }: { verse: VerseData }) {
  const slug = (verse.scripture || "").toLowerCase();
  const authorship = authorshipFor({
    kind: "verse",
    bookSlug: slug,
    vedabaseUrl: verse.vedabase_url,
    canto: verse.chapters?.canto_or_division,
    chapter: verse.chapters?.chapter_number,
  });
  const note = provenanceNoteFor(slug, authorship);
  return (
    <div className="passage-label" style={{ marginBottom: 10 }}>
      <span>Translation</span>
      {note && <span className="passage-label-note">{note}</span>}
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="section-label-row">
      <span className="section-label-line" />
      <span className="section-label-text">{text}</span>
      <style jsx>{`
        .section-label-row { display: flex; align-items: center; gap: 10px; }
        .section-label-line { width: 20px; height: 2px; background: var(--accent); border-radius: 1px; opacity: 0.55; }
        .section-label-text { font-family: var(--font-body), sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-subtle); }
      `}</style>
    </div>
  );
}
