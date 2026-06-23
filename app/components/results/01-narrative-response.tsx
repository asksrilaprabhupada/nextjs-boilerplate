/**
 * 01-narrative-response.tsx — Narrative Response with Summary Sidebar
 *
 * 2-column layout: 75% content + 25% sidebar (220px).
 * Sidebar shows numbered key answers (AI-generated) and sources-by-book counts.
 * Mobile: sidebar hidden, replaced by "View key answers" button + bottom-sheet popup.
 */
"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import WantMoreModal from "./02-want-more-modal";
import SearchFeedback from "../search/06-search-feedback";
import DigDeeperModal from "./03-dig-deeper-modal";
import {
  buildFoldPreviewHtml,
  buildFoldBlock,
  highlightParagraphsHtml,
  buildSectionText,
  type PassageType,
} from "@/app/lib/10-passage-fold";

export interface Citation {
  ref: string;
  book: string;
  url: string;
  type: "verse" | "prose" | "transcript" | "letter";
  title: string;
}

export interface VerseHit {
  id: string; scripture: string; verse_number: string; sanskrit_devanagari: string;
  transliteration: string; translation: string; purport: string;
  chapter_number?: string; canto_or_division?: string; chapter_title?: string;
  book_slug?: string; vedabase_url?: string; tags?: string[];
  score?: number; similarity?: number; matchedChunkText?: string;
}

export interface ProseHit {
  id: string; book_slug: string; paragraph_number: number; body_text: string;
  chapter_title?: string; vedabase_url?: string; tags?: string[];
  score?: number; similarity?: number; before?: string; after?: string;
}

export interface TranscriptHit {
  id: string; transcript_id?: string; paragraph_number: number; body_text: string;
  content_type?: string; title?: string; date?: string; location?: string;
  occasion?: string; scripture_ref?: string; vedabase_url?: string;
  tags?: string[]; score?: number; similarity?: number; before?: string; after?: string;
}

export interface LetterHit {
  id: string; letter_id?: string; paragraph_number: number; body_text: string;
  content_type?: string; title?: string; date?: string; location?: string;
  recipient?: string; vedabase_url?: string;
  tags?: string[]; score?: number; similarity?: number; before?: string; after?: string;
}

export interface KeyAnswer { id: string; ref: string; line: string; }

export interface BookGroup {
  slug: string; name: string; verses: VerseHit[]; prose: ProseHit[];
  transcripts?: TranscriptHit[]; letters?: LetterHit[];
}

export interface SearchResults {
  query: string;
  keywords: string[];
  synonyms: string[];
  relatedConcepts: string[];
  narrative: string;
  totalResults: number;
  citations: Citation[];
  books: BookGroup[];
  overflowVerses?: VerseHit[];
  overflowProse?: ProseHit[];
  overflowTranscripts?: TranscriptHit[];
  overflowLetters?: LetterHit[];
  totalVerses?: number;
  totalProse?: number;
  totalTranscripts?: number;
  totalLetters?: number;
  articleVerseIds?: string[];
  suggestion?: string | null;
  suggestionDisplay?: string | null;
  queryTerms?: string[];
  keyAnswers?: KeyAnswer[];
}

/* ─── Per-book color system (ONLY for tags and left borders) ─── */
const BOOK_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  SB:       { bg: "#EEEDFE", text: "#534AB7", border: "#AFA9EC" },
  CC:       { bg: "#FAECE7", text: "#993C1D", border: "#F0997B" },
  NOI:      { bg: "#E1F5EE", text: "#0F6E56", border: "#9FE1CB" },
  BG:       { bg: "#FAEEDA", text: "#854F0B", border: "#FAC775" },
  SPL:      { bg: "#FBEAF0", text: "#993556", border: "#ED93B1" },
  LECTURES: { bg: "#FFF7ED", text: "#C2410C", border: "#FB923C" },
  LETTERS:  { bg: "#F0FDF4", text: "#15803D", border: "#4ADE80" },
  default:  { bg: "#EEEDFE", text: "#534AB7", border: "#AFA9EC" },
};

export function getBookColor(reference: string) {
  const prefix = reference.split(" ")[0]?.toUpperCase() || "default";
  return BOOK_COLORS[prefix] || BOOK_COLORS["default"];
}

/* ─── Scroll helper ─── */
function scrollToSource(ref: string) {
  document.getElementById(`source-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ─── Mobile Summary Bottom-Sheet Popup ─── */
function SummaryPopup({
  isOpen,
  onClose,
  summaries,
  totalSources,
}: {
  isOpen: boolean;
  onClose: () => void;
  summaries: KeyAnswer[];
  totalSources: number;
}) {
  if (!isOpen) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100,
          animation: "summaryFadeIn 0.2s ease",
        }}
      />
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0, background: "white",
        borderRadius: "16px 16px 0 0", zIndex: 101, maxHeight: "80vh", overflowY: "auto",
        animation: "summarySlideUp 0.3s ease",
      }}>
        <div style={{ width: 36, height: 4, background: "#D0D0D0", borderRadius: 2, margin: "10px auto 0" }} />
        <div style={{ padding: "16px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M8 1.5l2 4 4.5.7-3.2 3.1.8 4.4L8 11.5l-4.1 2.2.8-4.4L1.5 6.2l4.5-.7z" fill="#7F77DD" stroke="none" />
            </svg>
            <span className="font-body" style={{ fontSize: 16, fontWeight: 500 }}>Key answers</span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.1)",
              background: "transparent", fontSize: 14, color: "#888", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            &times;
          </button>
        </div>
        <p className="font-body" style={{ fontSize: 12, color: "#888", margin: "0 20px 16px" }}>
          Top {summaries.length} most relevant from {totalSources} sources
        </p>
        <div style={{ padding: "0 20px 24px" }}>
          {summaries.map((item, i) => (
            <div
              key={item.id || i}
              onClick={() => { onClose(); setTimeout(() => scrollToSource(item.id), 300); }}
              style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 0",
                borderBottom: i < summaries.length - 1 ? "1px solid rgba(0,0,0,0.06)" : "none",
                cursor: "pointer",
              }}
            >
              <span style={{
                fontSize: 12, fontWeight: 500, color: "white", background: "#7F77DD",
                width: 22, height: 22, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>{i + 1}</span>
              <div>
                <p className="font-body" style={{ fontSize: 14, fontWeight: 500, margin: "0 0 4px", lineHeight: 1.5 }}>{item.line}</p>
                <span className="font-body" style={{ fontSize: 11, color: "#534AB7", background: "#EEEDFE", padding: "1px 8px", borderRadius: 4 }}>
                  {item.ref}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ─── Quote Tooltip (JS-powered, left-border hover zone) ─── */
function QuoteTooltip() {
  const [tooltip, setTooltip] = useState<{
    text: string;
    subtext: string;
    color: string;
    bg: string;
    border: string;
    dotColor: string;
    y: number;
    cardLeft: number;
    quoteTop: number;
    quoteHeight: number;
  } | null>(null);
  const [visible, setVisible] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [lineWidth, setLineWidth] = useState(0);

  useEffect(() => {
    if (visible && tooltipRef.current && tooltip) {
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const gap = tooltip.cardLeft - tooltipRect.right;
      setLineWidth(Math.max(gap + 4, 0));
    }
  }, [visible, tooltip]);

  useEffect(() => {
    const HOVER_ZONE_WIDTH = 35;

    const FULL_BOOK_NAMES: Record<string, string> = {
      'BG': 'Bhagavad-gītā As It Is',
      'SB': 'Śrīmad-Bhāgavatam',
      'CC': 'Śrī Caitanya-caritāmṛta',
      'NOI': 'Nectar of Instruction',
      'ISO': 'Śrī Īśopaniṣad',
      'BS': 'Śrī Brahma-saṁhitā',
      'LOB': 'Light of the Bhāgavata',
      'KB': 'Kṛṣṇa Book',
      'NOD': 'The Nectar of Devotion',
      'SSR': 'The Science of Self-Realization',
      'TLC': 'Teachings of Lord Caitanya',
      'TLK': 'Teachings of Lord Kapila',
      'TQK': 'Teachings of Queen Kuntī',
      'SC': 'A Second Chance',
      'BBD': 'Beyond Birth and Death',
      'BHAKTI': 'Bhakti: The Art of Eternal Love',
      'CAT': 'Civilization and Transcendence',
      'JOSD': 'The Journey of Self-Discovery',
      'OWK': 'On the Way to Kṛṣṇa',
      'POP': 'The Path of Perfection',
      'POY': 'The Perfection of Yoga',
      'PQPA': 'Perfect Questions, Perfect Answers',
      'RV': 'Rāja-vidyā: The King of Knowledge',
      'CABH': 'Chant and Be Happy',
      'SPL': 'Śrīla Prabhupāda-līlāmṛta',
      'RKD': 'Rāmāyaṇa',
      'MBK': 'Mahābhārata',
      'EJOP': 'Easy Journey to Other Planets',
      'EKC': 'Elevation to Kṛṣṇa Consciousness',
      'KCTY': 'Kṛṣṇa Consciousness: The Topmost Yoga System',
      'LCFL': 'Life Comes From Life',
      'MOG': 'Message of Godhead',
      'RTW': 'Renunciation Through Wisdom',
      'TOP': 'Transcendental Teachings of Prahlāda Mahārāja',
      'NBS': 'Nārada Bhakti Sūtra',
      'MMS': 'Mukunda-mālā-stotra',
    };

    const typeConfig: Record<string, { label: string; color: string; bg: string; border: string; dotColor: string }> = {
      'verse-quote': { label: 'Verse Translation', color: '#7C3AED', bg: 'rgba(245, 243, 255, 0.75)', border: '#C4B5FD', dotColor: '#8B5CF6' },
      'purport-quote': { label: 'Purport', color: '#6D28D9', bg: 'rgba(245, 243, 255, 0.75)', border: '#A78BFA', dotColor: '#7C3AED' },
      'prose-quote': { label: 'Book Passage', color: '#4F46E5', bg: 'rgba(238, 242, 255, 0.75)', border: '#A5B4FC', dotColor: '#6366F1' },
      'lecture-quote': { label: 'Lecture', color: '#C2410C', bg: 'rgba(255, 247, 237, 0.75)', border: '#FDBA74', dotColor: '#FB923C' },
      'letter-quote': { label: 'Letter', color: '#15803D', bg: 'rgba(240, 253, 244, 0.75)', border: '#86EFAC', dotColor: '#4ADE80' },
    };

    function getQuoteType(el: HTMLElement): string | null {
      for (const cls of Object.keys(typeConfig)) {
        if (el.classList.contains(cls)) return cls;
      }
      return null;
    }

    function expandBookAbbreviation(ref: string): string {
      const parts = ref.split(' ');
      const abbr = parts[0]?.toUpperCase();
      if (FULL_BOOK_NAMES[abbr]) {
        return FULL_BOOK_NAMES[abbr] + ' ' + parts.slice(1).join(' ');
      }
      return ref;
    }

    function extractBookRef(quoteEl: HTMLElement): string | null {
      // ONLY check the immediately preceding element — never go further
      const prev = quoteEl.previousElementSibling;
      if (!prev) return null;

      const refEl = prev.querySelector('.verse-ref');
      if (refEl && refEl.textContent) {
        let ref = refEl.textContent.replace(/[\[\]]/g, '').trim();
        // Clean up "Text" from verse numbers like "SB 5.14.Text 31"
        ref = ref.replace(/\.?Text\s*/gi, '.').replace(/\.+/g, '.').replace(/\.$/, '');
        return ref;
      }

      const linkEl = prev.querySelector('.verse-link');
      if (linkEl && linkEl.textContent) {
        let text = linkEl.textContent.replace(/[\[\]]/g, '').trim();
        text = text.replace(/\.?Text\s*/gi, '.').replace(/\.+/g, '.').replace(/\.$/, '');
        if (text.match(/^(BG|SB|CC|NOI|ISO|BS)\s/i)) return text;
      }

      return null;
    }

    function extractProseBookName(quoteEl: HTMLElement): string | null {
      // For prose/lecture/letter quotes, extract the book or source name from the text above
      const prev = quoteEl.previousElementSibling;
      if (!prev) return null;

      const text = prev.textContent || '';

      // Match patterns like "In Book Name, Śrīla Prabhupāda writes:"
      // or "In Book Name (Chapter), Śrīla Prabhupāda writes:"
      const bookPatterns = [
        /In\s+(.+?)(?:\s*\(|,\s*Śrīla|,\s*Prabhupāda|,\s*His\s+Divine)/i,
        /In\s+(.+?),\s+(?:Śrīla|Prabhupāda|His\s+Divine)/i,
        /From\s+(.+?)(?:,\s*Śrīla|,\s*Prabhupāda)/i,
      ];

      for (const pattern of bookPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          let name = match[1].trim();
          // Don't return if it's just "a lecture" or "a letter"
          if (/^a\s+(lecture|letter)/i.test(name)) return null;
          // Trim trailing punctuation
          name = name.replace(/[,.:;]+$/, '').trim();
          if (name.length > 3 && name.length < 80) return name;
        }
      }

      return null;
    }

    function extractLectureInfo(quoteEl: HTMLElement): string | null {
      let el: Element | null = quoteEl.previousElementSibling;
      let attempts = 0;
      while (el && attempts < 3) {
        const text = el.textContent || '';
        const dateMatch = text.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4})/i);
        const placeMatch = text.match(/(?:at|in)\s+([A-Z][a-zA-Zāīūṛṝḷṃḥṣṭḍṅñśṁ\s]+?)(?:,|\s+on\s|:|\s+Śrīla)/);
        const parts = [dateMatch?.[1], placeMatch?.[1]?.trim()].filter(Boolean);
        if (parts.length > 0) return parts.join(' · ');
        el = el.previousElementSibling;
        attempts++;
      }
      return null;
    }

    function extractLetterInfo(quoteEl: HTMLElement): string | null {
      let el: Element | null = quoteEl.previousElementSibling;
      let attempts = 0;
      while (el && attempts < 3) {
        const text = el.textContent || '';
        const recipientMatch = text.match(/letter\s+to\s+([^,]+?)(?:\s+on\s|,|\s*Śrīla|:)/i);
        const dateMatch = text.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4})/i);
        const parts = [recipientMatch?.[1]?.trim(), dateMatch?.[1]].filter(Boolean);
        if (parts.length > 0) return parts.join(' · ');
        el = el.previousElementSibling;
        attempts++;
      }
      return null;
    }

    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    function handleMouseMove(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const quoteEl = target.closest('.verse-quote, .purport-quote, .prose-quote, .lecture-quote, .letter-quote') as HTMLElement | null;

      if (!quoteEl) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { setVisible(false); setTimeout(() => setTooltip(null), 300); }, 80);
        return;
      }

      const rect = quoteEl.getBoundingClientRect();
      const mouseXRelative = e.clientX - rect.left;

      if (mouseXRelative > HOVER_ZONE_WIDTH) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { setVisible(false); setTimeout(() => setTooltip(null), 300); }, 80);
        return;
      }

      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

      const quoteType = getQuoteType(quoteEl);
      if (!quoteType) return;

      const config = typeConfig[quoteType];
      let mainText = config.label;
      let subtext = '';

      if (quoteType === 'verse-quote' || quoteType === 'purport-quote') {
        const bookRef = extractBookRef(quoteEl);
        if (bookRef) {
          mainText = expandBookAbbreviation(bookRef);
          subtext = config.label;
        }
      } else if (quoteType === 'prose-quote') {
        const bookName = extractProseBookName(quoteEl);
        if (bookName) {
          mainText = bookName;
          subtext = config.label;
        }
      } else if (quoteType === 'lecture-quote') {
        const info = extractLectureInfo(quoteEl);
        if (info) subtext = info;
      } else if (quoteType === 'letter-quote') {
        const info = extractLetterInfo(quoteEl);
        if (info) subtext = info;
      }

      const cardEl = quoteEl.closest('.aurora-card');
      const cardLeft = cardEl ? cardEl.getBoundingClientRect().left : rect.left;

      setTooltip({
        text: mainText,
        subtext,
        color: config.color,
        bg: config.bg,
        border: config.border,
        dotColor: config.dotColor,
        y: rect.top + rect.height / 2,
        cardLeft,
        quoteTop: rect.top,
        quoteHeight: rect.height,
      });
      setVisible(true);
    }

    const narrativeEl = document.querySelector('.narrative-content');
    if (narrativeEl) {
      narrativeEl.addEventListener('mousemove', handleMouseMove as EventListener);
    }

    return () => {
      if (narrativeEl) {
        narrativeEl.removeEventListener('mousemove', handleMouseMove as EventListener);
      }
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!tooltip) return null;

  return (
    <>
      {/* Connecting line from tooltip to quote border */}
      {visible && lineWidth > 0 && (
        <div
          style={{
            position: 'fixed',
            top: tooltip.y,
            left: tooltip.cardLeft - lineWidth,
            width: lineWidth + 4,
            height: 2,
            zIndex: 999,
            pointerEvents: 'none',
            transform: 'translateY(-50%)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              background: `linear-gradient(90deg, ${tooltip.dotColor}00, ${tooltip.dotColor}66, ${tooltip.dotColor})`,
              borderRadius: 1,
              animation: 'tooltipLineGrow 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
              transformOrigin: 'right center',
            }}
          />
        </div>
      )}

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        style={{
          position: 'fixed',
          top: tooltip.y,
          left: tooltip.cardLeft - 12,
          transform: visible
            ? 'translateX(-100%) translateY(-50%) translateX(0) scale(1)'
            : 'translateX(-100%) translateY(-50%) translateX(12px) scale(0.88)',
          padding: '9px 16px 9px 12px',
          borderRadius: 12,
          fontFamily: "'DM Sans', sans-serif",
          whiteSpace: 'normal',
          color: tooltip.color,
          background: tooltip.bg,
          backdropFilter: 'blur(16px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
          border: `1px solid ${tooltip.border}`,
          boxShadow: `0 8px 32px rgba(0,0,0,0.06), 0 0 0 1px ${tooltip.border}18`,
          zIndex: 1000,
          pointerEvents: 'none',
          opacity: visible ? 1 : 0,
          animation: visible ? 'tooltipElasticIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards' : 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 3,
          maxWidth: Math.max(tooltip.cardLeft - 32, 120),
          overflow: 'hidden',
        }}
      >
        {/* Shimmer sweep overlay */}
        {visible && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 12,
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: '-100%',
                width: '60%',
                height: '100%',
                background: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.5) 50%, transparent 70%)',
                animation: 'tooltipShimmer 0.8s ease-out 0.3s forwards',
              }}
            />
          </div>
        )}

        {/* Content */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, position: 'relative', zIndex: 1 }}>
          <span style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tooltip.dotColor,
            flexShrink: 0,
            boxShadow: `0 0 6px ${tooltip.dotColor}44`,
            animation: visible ? 'tooltipDotPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s both' : 'none',
          }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.01em', lineHeight: 1.4 }}>
            {tooltip.text}
          </span>
        </div>
        {tooltip.subtext && (
          <span style={{
            fontSize: 10,
            fontWeight: 500,
            opacity: 0.65,
            marginLeft: 15,
            lineHeight: 1.3,
            whiteSpace: 'normal',
            position: 'relative',
            zIndex: 1,
          }}>
            {tooltip.subtext}
          </span>
        )}
      </div>
    </>
  );
}

/* ─── Main Component ─── */
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

export default function NarrativeResponse({ results, isLoading, isStreaming, streamingNarrative, onSearch, searchLogId, viewMode, onViewModeChange }: Props) {
  const [modalBook, setModalBook] = useState<BookGroup | null>(null);
  const [digDeeperOpen, setDigDeeperOpen] = useState(false);
  const [showSummaryPopup, setShowSummaryPopup] = useState(false);

  // Reset states when results change
  useEffect(() => {
    setDigDeeperOpen(false);
    setShowSummaryPopup(false);
  }, [results?.query]);

  // Key answers are VERBATIM lines computed by the server (verse → translation;
  // prose/lecture/letter → the matched sentence) — no AI, never paraphrased.
  const summaries: KeyAnswer[] = results?.keyAnswers || [];
  const queryTerms: string[] = results?.queryTerms || [];

  // Follow-up suggestions — extract themes from search results
  const followUps = useMemo(() => {
    if (!results || results.totalResults === 0) return [];
    const themes = results.citations
      .slice(0, 10)
      .map(c => c.title)
      .filter(t => t && t.length > 5)
      .slice(0, 3);
    if (themes.length === 0) return [];
    return themes.map(t => `What does Prabhupāda teach about ${t}?`);
  }, [results]);

  if (isLoading) return null;
  if (!results) return null;

  if (results.totalResults === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px", gap: 12 }}>
        <p className="font-display" style={{ fontSize: "1.1rem", color: "#6B7280", fontStyle: "italic" }}>No results found.</p>
        <p className="font-body" style={{ fontSize: 14, color: "#6B7280" }}>Try different words or a simpler question.</p>
      </div>
    );
  }

  // The expand label a folded block returns to when collapsed.
  const foldCollapsedLabel = (type: string) =>
    type === "purport" ? "Read the full purport →"
      : type === "verse" ? "Read the full translation →"
        : "Read in context →";

  // Reconstruct the COMPLETE, faithful text of any folded passage from data already
  // on the client (lossless — nothing is fetched). Verses use the full purport /
  // translation; prose/lecture/letter use the matched paragraph + its neighbours.
  // The matched line + query words are highlighted with the SAME shared helper.
  const buildFullHtml = (type: string, id: string): string => {
    if (type === "verse" || type === "purport") {
      const v = results.books.flatMap(b => b.verses).find(x => x.id === id)
        || (results.overflowVerses || []).find(x => x.id === id);
      if (!v) return "";
      return type === "purport"
        ? highlightParagraphsHtml(v.purport || "", v.matchedChunkText, queryTerms)
        : highlightParagraphsHtml(v.translation || "", undefined, queryTerms);
    }
    if (type === "prose") {
      const p = results.books.flatMap(b => b.prose).find(x => x.id === id)
        || (results.overflowProse || []).find(x => x.id === id);
      if (!p) return "";
      return highlightParagraphsHtml(buildSectionText(p.body_text || "", p.before, p.after), undefined, queryTerms);
    }
    if (type === "lecture") {
      const t = results.books.flatMap(b => b.transcripts || []).find(x => x.id === id)
        || (results.overflowTranscripts || []).find(x => x.id === id);
      if (!t) return "";
      return highlightParagraphsHtml(buildSectionText(t.body_text || "", t.before, t.after), undefined, queryTerms);
    }
    const l = results.books.flatMap(b => b.letters || []).find(x => x.id === id)
      || (results.overflowLetters || []).find(x => x.id === id);
    if (!l) return "";
    return highlightParagraphsHtml(buildSectionText(l.body_text || "", l.before, l.after), undefined, queryTerms);
  };

  // Builds the unified fold-block HTML for a References passage with the SAME
  // helper the server uses for the Article — one fold + highlight mechanism.
  const foldHtmlFor = (
    type: PassageType,
    id: string,
    text: string,
    opts?: { matchedChunkText?: string; anchorId?: string | null; expandLabel?: string },
  ): string => {
    const fp = buildFoldPreviewHtml({ type, text: text || "", matchedChunkText: opts?.matchedChunkText, queryTerms });
    return buildFoldBlock({
      type, id, anchorId: opts?.anchorId,
      previewHtml: fp.previewHtml, truncated: fp.truncated, expandLabel: opts?.expandLabel,
    });
  };

  // Unified click handler for ALL folded passages (Article AND References), rendered
  // via dangerouslySetInnerHTML. One mechanism — never navigate away.
  const handleFoldClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    const expandBtn = target.closest(".fold-expand-btn");
    if (expandBtn) {
      const block = expandBtn.closest(".fold-block") as HTMLElement | null;
      if (!block) return;
      const id = block.getAttribute("data-passage-id") || "";
      const type = block.getAttribute("data-passage-type") || "";

      const preview = block.querySelector(".fold-preview") as HTMLElement | null;
      const existingFull = block.querySelector(".fold-full") as HTMLElement | null;

      if (existingFull) {
        existingFull.remove();
        preview?.removeAttribute("hidden");
        block.classList.add("is-folded");
        expandBtn.textContent = foldCollapsedLabel(type);
        return;
      }

      const fullHtml = buildFullHtml(type, id);
      if (!fullHtml) return;
      const full = document.createElement("div");
      full.className = "fold-full";
      full.innerHTML = fullHtml;
      preview?.setAttribute("hidden", "");
      block.classList.remove("is-folded");
      block.insertBefore(full, expandBtn);
      expandBtn.textContent = "Show less ↑";
      requestAnimationFrame(() => full.classList.add("is-open"));
      return;
    }

    // "Want more" book modal trigger (dormant in the current template, kept for safety)
    const trigger = target.closest(".want-more-trigger");
    if (trigger) {
      const bookSlug = trigger.getAttribute("data-book");
      const book = results.books.find(b => b.slug === bookSlug);
      if (book) setModalBook(book);
    }
  };

  // Book breakdown for sidebar
  const bookGroups = results.books
    .map(b => ({ name: b.name, slug: b.slug, count: b.verses.length + b.prose.length }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <>
      {/* Controls row — sits ABOVE the grid */}
      <div className="results-controls-row">
        {/* Mobile: View key answers button */}
        {summaries.length > 0 && (
          <div
            className="mobile-only-btn"
            onClick={() => setShowSummaryPopup(true)}
            style={{
              width: "100%", padding: "12px 16px", background: "#EEEDFE", border: "1px solid #CECBF6",
              borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center",
              justifyContent: "space-between", marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 16 16">
                <path d="M8 1.5l2 4 4.5.7-3.2 3.1.8 4.4L8 11.5l-4.1 2.2.8-4.4L1.5 6.2l4.5-.7z" fill="#7F77DD" stroke="none" />
              </svg>
              <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: "#3C3489" }}>View key answers</span>
            </div>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M5 3l5 4-5 4" fill="none" stroke="#3C3489" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        )}

        {/* ─── Article / References Toggle ─── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span className="font-body" style={{ fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" }}>View as</span>
          <div className="view-mode-toggle">
            <button
              className={`font-body${viewMode === "article" ? " active" : ""}`}
              onClick={() => onViewModeChange("article")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="1" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <line x1="4.5" y1="4" x2="9.5" y2="4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="4.5" y1="6.5" x2="9.5" y2="6.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="4.5" y1="9" x2="7.5" y2="9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              </svg>
              Article
            </button>
            <button
              className={`font-body${viewMode === "references" ? " active" : ""}`}
              onClick={() => onViewModeChange("references")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1.5" width="4" height="5" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="1" y="7.5" width="4" height="5" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <line x1="7" y1="2.5" x2="13" y2="2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="7" y1="4.5" x2="11" y2="4.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                <line x1="7" y1="8.5" x2="13" y2="8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="7" y1="10.5" x2="11" y2="10.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
              </svg>
              References
            </button>
          </div>
        </div>
      </div>

      {/* 2-column grid — both columns now start at the same level */}
      <div className="results-grid-container">
        {/* ─── Content Column ─── */}
        <div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.45, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}>

            {/* ─── Article Mode ─── */}
            {viewMode === "article" && (
              <div style={{ opacity: 1, transform: "translateY(0)", transition: "opacity 0.2s ease, transform 0.2s ease" }}>
                <div className="aurora-card" style={{ padding: "32px clamp(20px, 3vw, 32px)", borderRadius: 24 }}>
                  <div
                    className="narrative-content font-body"
                    dangerouslySetInnerHTML={{ __html: results.narrative }}
                    onClick={handleFoldClick}
                    style={{ fontSize: 15, lineHeight: 1.8, color: "#374151" }}
                  />
                </div>

                {/* Feedback widget */}
                {results && results.totalResults > 0 && (
                  <SearchFeedback searchLogId={searchLogId || null} />
                )}

                {/* Dig Deeper */}
                {results && ((results.totalVerses || 0) + (results.totalProse || 0) + (results.totalTranscripts || 0) + (results.totalLetters || 0)) > 25 && (
                  <button
                    onClick={() => setDigDeeperOpen(true)}
                    className="font-body"
                    style={{
                      width: "100%", marginTop: 16, padding: "14px 20px", borderRadius: 16,
                      border: "1px dashed rgba(196,181,253,0.4)", background: "rgba(139,92,246,0.04)",
                      fontSize: 14, fontWeight: 600, color: "#7C3AED", cursor: "pointer",
                      textAlign: "center", transition: "all 0.3s ease",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.1)"; e.currentTarget.style.borderColor = "#8B5CF6"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "rgba(139,92,246,0.04)"; e.currentTarget.style.borderColor = "rgba(196,181,253,0.4)"; }}
                  >
                    Explore all {(results.overflowVerses?.length || 0) + (results.overflowProse?.length || 0) + (results.overflowTranscripts?.length || 0) + (results.overflowLetters?.length || 0)} additional sources &rarr;
                  </button>
                )}

                {/* Follow-up questions */}
                {followUps.length > 0 && (
                  <div style={{ marginTop: 20, padding: "clamp(14px, 3vw, 20px) clamp(16px, 3vw, 24px)", borderRadius: 20, background: "rgba(245,240,255,0.4)", border: "1px solid rgba(196,181,253,0.2)" }}>
                    <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6B7280", marginBottom: 12 }}>
                      People also explore
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {followUps.map((q, i) => (
                        <button
                          key={`${i}-${q}`}
                          onClick={() => onSearch(q)}
                          className="font-body"
                          style={{ textAlign: "left", padding: "10px 16px", borderRadius: 12, border: "1px solid rgba(196,181,253,0.25)", background: "rgba(255,255,255,0.6)", fontSize: 14, color: "#374151", cursor: "pointer", transition: "all 0.3s ease" }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = "#8B5CF6"; e.currentTarget.style.color = "#7C3AED"; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.25)"; e.currentTarget.style.color = "#374151"; }}
                        >
                          {q} &rarr;
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─── References Mode ─── */}
            {viewMode === "references" && (
              <div onClick={handleFoldClick} style={{ opacity: 1, transform: "translateY(0)", transition: "opacity 0.2s ease, transform 0.2s ease" }}>
                {results.books.filter(b => b.verses.length > 0 || b.prose.length > 0 || (b.transcripts?.length || 0) > 0 || (b.letters?.length || 0) > 0).map(book => {
                  const bookColor = getBookColor(book.slug.toUpperCase());
                  const tCount = book.transcripts?.length || 0;
                  const lCount = book.letters?.length || 0;
                  return (
                    <div key={book.slug} className="references-book-group">
                      <h3>{book.name}</h3>
                      <p className="references-book-count">
                        {book.verses.length > 0 && `${book.verses.length} verse${book.verses.length !== 1 ? "s" : ""}`}
                        {book.verses.length > 0 && (book.prose.length > 0 || tCount > 0 || lCount > 0) && " · "}
                        {book.prose.length > 0 && `${book.prose.length} passage${book.prose.length !== 1 ? "s" : ""}`}
                        {book.prose.length > 0 && (tCount > 0 || lCount > 0) && " · "}
                        {tCount > 0 && `${tCount} lecture${tCount !== 1 ? "s" : ""}`}
                        {tCount > 0 && lCount > 0 && " · "}
                        {lCount > 0 && `${lCount} letter${lCount !== 1 ? "s" : ""}`}
                      </p>

                      {book.verses.map(v => {
                        const ref = `${v.scripture || ""} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${v.verse_number}`.trim();
                        const vColor = getBookColor(ref);
                        return (
                          <div key={v.id} className="reference-card" style={{ borderLeft: `3px solid ${vColor.border}` }}>
                            <span style={{
                              display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px",
                              borderRadius: 8, background: vColor.bg, color: vColor.text,
                            }}>
                              [{ref}]
                            </span>
                            {v.translation && (
                              <div className="reference-fold" dangerouslySetInnerHTML={{ __html: foldHtmlFor("verse", v.id, v.translation, { expandLabel: "Read the full translation →" }) }} />
                            )}
                            {v.purport && (
                              <div className="reference-fold" dangerouslySetInnerHTML={{ __html: foldHtmlFor("purport", v.id, v.purport, { matchedChunkText: v.matchedChunkText, anchorId: null, expandLabel: "Read the full purport →" }) }} />
                            )}
                            <div className="reference-card__links">
                              <a href={`/verse/${v.id}`} style={{ color: "#534AB7" }}>
                                Read full purport &rarr;
                              </a>
                              {v.vedabase_url && (
                                <a href={v.vedabase_url} target="_blank" rel="noopener noreferrer" style={{ color: "#888" }}>
                                  Open on Vedabase &#8599;
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {book.prose.map(p => (
                        <div key={p.id} className="reference-card" style={{ borderLeft: `3px solid ${bookColor.border}` }}>
                          {p.chapter_title && (
                            <span style={{
                              display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px",
                              borderRadius: 8, background: bookColor.bg, color: bookColor.text,
                            }}>
                              {p.chapter_title}
                            </span>
                          )}
                          <div className="reference-fold" dangerouslySetInnerHTML={{ __html: foldHtmlFor("prose", p.id, p.body_text, { expandLabel: "Read in context →" }) }} />
                          <div className="reference-card__links">
                            <span />
                            {p.vedabase_url && (
                              <a href={p.vedabase_url} target="_blank" rel="noopener noreferrer" style={{ color: "#888" }}>
                                Open on Vedabase &#8599;
                              </a>
                            )}
                          </div>
                        </div>
                      ))}

                      {(book.transcripts || []).map(t => {
                        const lectureColor = BOOK_COLORS["LECTURES"];
                        const datePart = t.date ? new Date(t.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
                        const label = t.title || [datePart, t.location].filter(Boolean).join(" — ") || "Lecture";
                        return (
                          <div key={t.id} className="reference-card" style={{ borderLeft: `3px solid ${lectureColor.border}` }}>
                            <span style={{
                              display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px",
                              borderRadius: 8, background: lectureColor.bg, color: lectureColor.text,
                            }}>
                              Lecture
                            </span>
                            <p style={{ fontSize: 12, color: "#666", margin: "4px 0 2px", fontStyle: "italic" }}>
                              {label}
                            </p>
                            <div className="reference-fold" dangerouslySetInnerHTML={{ __html: foldHtmlFor("lecture", t.id, t.body_text, { expandLabel: "Read in context →" }) }} />
                            <div className="reference-card__links">
                              <span />
                              {t.vedabase_url && (
                                <a href={t.vedabase_url} target="_blank" rel="noopener noreferrer" style={{ color: "#888" }}>
                                  Open on Vedabase &#8599;
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {(book.letters || []).map(l => {
                        const letterColor = BOOK_COLORS["LETTERS"];
                        const datePart = l.date ? new Date(l.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
                        const label = [l.recipient ? `To ${l.recipient}` : "", datePart].filter(Boolean).join(" — ") || "Letter";
                        return (
                          <div key={l.id} className="reference-card" style={{ borderLeft: `3px solid ${letterColor.border}` }}>
                            <span style={{
                              display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px",
                              borderRadius: 8, background: letterColor.bg, color: letterColor.text,
                            }}>
                              Letter
                            </span>
                            <p style={{ fontSize: 12, color: "#666", margin: "4px 0 2px", fontStyle: "italic" }}>
                              {label}
                            </p>
                            <div className="reference-fold" dangerouslySetInnerHTML={{ __html: foldHtmlFor("letter", l.id, l.body_text, { expandLabel: "Read in context →" }) }} />
                            <div className="reference-card__links">
                              <span />
                              {l.vedabase_url && (
                                <a href={l.vedabase_url} target="_blank" rel="noopener noreferrer" style={{ color: "#888" }}>
                                  Open on Vedabase &#8599;
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Dig Deeper in references mode */}
                {results && ((results.totalVerses || 0) + (results.totalProse || 0) + (results.totalTranscripts || 0) + (results.totalLetters || 0)) > 25 && (
                  <button
                    onClick={() => setDigDeeperOpen(true)}
                    className="font-body"
                    style={{
                      width: "100%", marginTop: 16, padding: "14px 20px", borderRadius: 16,
                      border: "1px dashed rgba(196,181,253,0.4)", background: "rgba(139,92,246,0.04)",
                      fontSize: 14, fontWeight: 600, color: "#7C3AED", cursor: "pointer",
                      textAlign: "center", transition: "all 0.3s ease",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.1)"; e.currentTarget.style.borderColor = "#8B5CF6"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "rgba(139,92,246,0.04)"; e.currentTarget.style.borderColor = "rgba(196,181,253,0.4)"; }}
                  >
                    Explore all {(results.overflowVerses?.length || 0) + (results.overflowProse?.length || 0) + (results.overflowTranscripts?.length || 0) + (results.overflowLetters?.length || 0)} additional sources &rarr;
                  </button>
                )}
              </div>
            )}
          </motion.div>
        </div>

        {/* ─── Desktop Summary Sidebar ─── */}
        <div className="desktop-sidebar" style={{ opacity: 1 }}>
          <div style={{
            background: "white", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12,
            padding: 16, position: "sticky", top: 80, alignSelf: "start",
          }}>
            {/* Key answers section */}
            {summaries.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <path d="M7 1l1.8 3.6L13 5.3l-3 2.9.7 4.1L7 10.4l-3.7 1.9.7-4.1-3-2.9 4.2-.7z" fill="#7F77DD" stroke="none" />
                  </svg>
                  <span className="font-body" style={{ fontSize: 13, fontWeight: 500 }}>Key answers</span>
                </div>
                {summaries.map((item, i) => (
                  <div
                    key={item.id || i}
                    onClick={() => scrollToSource(item.id)}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 12,
                      animation: `sidebarItemIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.08}s both`,
                    }}
                  >
                    <span style={{
                      fontSize: 11, fontWeight: 500, color: "#534AB7", background: "#EEEDFE",
                      padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap", marginTop: 2,
                      animation: `badgePop 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.08 + 0.1}s both`,
                    }}>{i + 1}</span>
                    <div>
                      <p className="font-body" style={{ fontSize: 12, margin: "0 0 2px", lineHeight: 1.5 }}>{item.line}</p>
                      <span className="font-body" style={{ fontSize: 11, color: "#888" }}>{item.ref}</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Divider */}
            <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", margin: "14px 0" }} />

            {/* Sources by book */}
            <p className="font-body" style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.3px", margin: "0 0 8px" }}>
              Sources by book
            </p>
            {bookGroups.map(g => (
              <div key={g.name} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                <span className="font-body" style={{ fontSize: 12 }}>{g.name}</span>
                <span className="font-body" style={{ fontSize: 11, color: "#888" }}>{g.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile Summary Popup */}
      <SummaryPopup
        isOpen={showSummaryPopup}
        onClose={() => setShowSummaryPopup(false)}
        summaries={summaries}
        totalSources={(results.totalVerses || 0) + (results.totalProse || 0) + (results.totalTranscripts || 0) + (results.totalLetters || 0)}
      />

      {/* Want More Modal */}
      {modalBook && <WantMoreModal book={modalBook} onClose={() => setModalBook(null)} />}

      {/* Dig Deeper Modal */}
      {digDeeperOpen && results && (
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

      <QuoteTooltip />

      {/* Styles */}
      <style jsx global>{`
        /* Controls row above grid */
        .results-controls-row {
          max-width: 1100px;
          margin: 0 auto;
          padding: 0 20px;
        }

        @media (max-width: 768px) {
          .results-controls-row {
            padding: 0 16px;
          }
        }

        /* 2-column grid: content (1fr) + sidebar (220px) — aligned at top */
        .results-grid-container {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 220px;
          gap: 20px;
          align-items: start;
          max-width: 1100px;
          margin: 0 auto;
          padding: 0 20px;
        }

        /* Mobile: single column */
        @media (max-width: 768px) {
          .results-grid-container {
            grid-template-columns: 1fr;
            padding: 0 16px;
          }
        }

        /* Desktop sidebar visibility */
        .desktop-sidebar { display: block; }
        @media (max-width: 768px) { .desktop-sidebar { display: none; } }

        /* Mobile button visibility */
        .mobile-only-btn { display: none !important; }
        @media (max-width: 768px) { .mobile-only-btn { display: flex !important; } }

        /* Bottom-sheet animations */
        @keyframes summaryFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes summarySlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

        /* Scripture card styles */
        .scripture-card {
          padding: 16px 20px;
          margin-bottom: 20px;
          border-left: 3px solid #AFA9EC;
          background: #FAFAFA;
          border-radius: 0 8px 8px 0;
        }
        .scripture-card__reference-tag {
          display: inline-block;
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 8px;
          margin-bottom: 10px;
          background: #EEEDFE;
          color: #534AB7;
        }
        .scripture-card__text {
          font-size: 16px;
          line-height: 1.8;
          font-style: italic;
          font-family: Georgia, 'Times New Roman', serif;
          color: #1a1a1a;
          margin: 0;
        }
        @media (max-width: 768px) {
          .scripture-card__text {
            font-size: 15px;
            line-height: 1.75;
          }
        }

        /* ─── Cinematic compose-in: the answer assembles itself, top to bottom.
           The intro appears, then each block (heading, transition, source) rises in
           gently, one after another. Pure CSS, so it runs the moment the injected
           article HTML mounts (re-runs on each new search) and degrades to instant
           under reduced motion. Supersedes the old per-type entrance. ─── */
        .narrative-content > * {
          animation: composeIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes composeIn {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .narrative-content > *:nth-child(1) { animation-delay: 0.02s; }
        .narrative-content > *:nth-child(2) { animation-delay: 0.08s; }
        .narrative-content > *:nth-child(3) { animation-delay: 0.14s; }
        .narrative-content > *:nth-child(4) { animation-delay: 0.20s; }
        .narrative-content > *:nth-child(5) { animation-delay: 0.26s; }
        .narrative-content > *:nth-child(6) { animation-delay: 0.32s; }
        .narrative-content > *:nth-child(7) { animation-delay: 0.38s; }
        .narrative-content > *:nth-child(8) { animation-delay: 0.44s; }
        .narrative-content > *:nth-child(9) { animation-delay: 0.50s; }
        .narrative-content > *:nth-child(10) { animation-delay: 0.56s; }
        .narrative-content > *:nth-child(n+11) { animation-delay: 0.62s; }

        /* References cards rise in gently too (calmer — no per-card cascade). */
        .reference-card { animation: composeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }

        /* Reduced motion: the global rule squashes duration; also drop the stagger
           delays so nothing is held invisible while its delay elapses. */
        @media (prefers-reduced-motion: reduce) {
          .narrative-content > *, .reference-card { animation-delay: 0s !important; }
        }

        /* Narrative content styles */
        .narrative-content h3 {
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.2rem; font-weight: 600; color: #1E1B4B;
          margin: 28px 0 12px; padding-bottom: 8px;
          border-bottom: 1px solid rgba(196,181,253,0.2);
        }
        .narrative-content h3:first-child { margin-top: 0; }
        .narrative-content p {
          margin-bottom: 16px; font-size: 16px; line-height: 1.85; color: #1E1B4B;
        }
        .narrative-content .verse-quote {
          background: transparent; border: none;
          border-left: 3px solid #8B5CF6; padding: 12px 20px; border-radius: 0; margin: 20px 0;
          font-family: Georgia, 'Times New Roman', serif; font-size: 16px; font-style: italic; line-height: 1.8; color: #1E1B4B;
        }
        .narrative-content .purport-quote {
          background: transparent; border: none;
          border-left: 3px solid #7C3AED; padding: 12px 20px; border-radius: 0; margin: 16px 0;
          font-size: 15px; line-height: 1.8; color: #374151;
        }
        /* Paragraphs in whole passages, previews, and inline-expanded full text. */
        .pp { margin: 0 0 12px; font-size: 15px; line-height: 1.8; color: #374151; }
        .pp:last-child { margin-bottom: 0; }
        .pp-ellipsis {
          color: #A78BFA; text-align: center; letter-spacing: 0.3em;
          margin: 10px 0; user-select: none;
        }

        /* ─── Unified fold (shared by the Article AND References) ─── */
        .fold-block { position: relative; }
        .fold-preview { position: relative; }
        /* Folded preview: clamp to a few lines and gently fade the last line so a
           snippet never looks like the whole teaching. Line-clamp makes the box
           EXACTLY N lines (no empty dead-zone below the text); the mask fades the
           text itself, so it is background-independent and ends at the last line. */
        .fold-block.is-folded .fold-preview {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: var(--fold-preview-lines, 3);
          line-clamp: var(--fold-preview-lines, 3);
          overflow: hidden;
          -webkit-mask-image: linear-gradient(to bottom, #000 56%, rgba(0,0,0,0.4) 82%, transparent 100%);
          mask-image: linear-gradient(to bottom, #000 56%, rgba(0,0,0,0.4) 82%, transparent 100%);
        }
        /* Inside a folded box, paragraphs must flow inline for line-clamp to apply. */
        .fold-block.is-folded .fold-preview .pp { display: inline; margin: 0; }
        .fold-preview[hidden] { display: none; }
        .fold-expand-btn {
          display: inline-flex; align-items: center; gap: 6px; margin-top: 10px;
          padding: 4px 0; background: none; border: none; cursor: pointer;
          font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; color: #7C3AED;
        }
        .fold-expand-btn:hover { color: #6D28D9; text-decoration: underline; }
        .fold-full {
          overflow: hidden; max-height: 0; opacity: 0;
          transition: max-height 0.6s ease, opacity 0.45s ease;
        }
        .fold-full.is-open { max-height: 100000px; opacity: 1; }

        /* ─── Matched-line highlight: true + calm, in the lavender–violet palette
           (never a flat yellow block). Layer 1 = matched sentence; layer 2 = query
           words. Browser-default <mark> yellow is overridden by these classes. ─── */
        mark.hl-sentence, mark.hl-word { color: inherit; }
        /* Layer 1 — the matched sentence: a soft, graded violet glow with faded
           left/right edges (a horizontal gradient that stops short of full height),
           so the line looks gently LIT, not painted into a hard rectangle. On first
           appearance it blooms left→right once (hlBloom, ~1s ease-out) then settles
           into this quiet, steady tint. One-time — never loops. */
        .hl-sentence {
          background-image: linear-gradient(90deg,
            rgba(167,139,250,0) 0%, rgba(167,139,250,0.16) 9%,
            rgba(139,92,246,0.16) 91%, rgba(139,92,246,0) 100%);
          background-repeat: no-repeat;
          background-position: left center;
          background-size: 100% 76%;
          border-radius: 7px;
          padding: 0.04em 0.32em;
          box-shadow: 0 1px 12px rgba(139,92,246,0.10);
          -webkit-box-decoration-break: clone;
          box-decoration-break: clone;
          animation: hlBloom 1.05s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes hlBloom {
          from { background-size: 0% 76%; box-shadow: 0 1px 12px rgba(139,92,246,0); }
          to   { background-size: 100% 76%; box-shadow: 0 1px 12px rgba(139,92,246,0.10); }
        }
        /* Layer 2 — query words: a subtle violet marker-underline, not a hard fill. */
        .hl-word {
          background-image: linear-gradient(transparent 58%, rgba(139,92,246,0.22) 58%);
          border-radius: 1px;
          padding: 0 0.5px;
          font-weight: 500;
          color: #5B21B6;
        }

        /* References folds reuse the same mechanism; give them a little breathing room. */
        .reference-fold { margin: 8px 0; }
        .reference-fold .fold-block { margin: 0; }
        .narrative-content .prose-quote {
          background: transparent; border: none;
          border-left: 3px solid #6366F1; padding: 12px 20px; border-radius: 0; margin: 16px 0;
          font-size: 15px; line-height: 1.8; color: #374151;
        }
        .narrative-content .lecture-quote {
          background: rgba(251,146,60,0.04); border: none;
          border-left: 3px solid #FB923C; padding: 12px 20px; border-radius: 0; margin: 16px 0;
          font-size: 15px; line-height: 1.8; color: #374151;
        }
        .narrative-content .letter-quote {
          background: rgba(74,222,128,0.04); border: none;
          border-left: 3px solid #4ADE80; padding: 12px 20px; border-radius: 0; margin: 16px 0;
          font-size: 15px; line-height: 1.8; color: #374151;
        }
        .narrative-content .verse-ref {
          font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600;
          color: #8B5CF6; font-style: normal;
        }
        .narrative-content .verse-link { text-decoration: none; color: #8B5CF6; }
        .narrative-content .verse-link:hover { text-decoration: underline; }
        .narrative-content .want-more-trigger {
          text-align: center; padding: 12px; margin: 16px 0 8px;
          font-size: 13px; font-weight: 600; color: #7C3AED; cursor: pointer;
          border: 1px dashed rgba(196,181,253,0.4); border-radius: 12px;
          background: rgba(139,92,246,0.04); transition: all 0.3s ease;
        }
        .narrative-content .want-more-trigger:hover {
          background: rgba(139,92,246,0.1); border-color: #8B5CF6;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.3); }
        }
        @keyframes articlePulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        /* Article/References toggle */
        .view-mode-toggle {
          display: inline-flex;
          border: 1px solid rgba(0,0,0,0.12);
          border-radius: 10px;
          overflow: hidden;
        }
        .view-mode-toggle button {
          padding: 8px 18px;
          font-size: 13px;
          font-weight: 500;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .view-mode-toggle button.active {
          background: #534AB7;
          color: white;
        }
        .view-mode-toggle button:not(.active) {
          background: transparent;
          color: #666;
        }
        .view-mode-toggle button:not(.active):hover {
          background: rgba(83, 74, 183, 0.08);
        }

        /* References view cards */
        .references-book-group {
          margin-bottom: 32px;
        }
        .references-book-group h3 {
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.15rem;
          font-weight: 600;
          color: #1E1B4B;
          margin: 0 0 4px;
        }
        .references-book-count {
          font-size: 12px;
          color: #888;
          margin-bottom: 16px;
        }
        .reference-card {
          margin-bottom: 14px;
          padding: 16px 20px;
          background: #FAFAFA;
          border-radius: 0 8px 8px 0;
          transition: background 0.2s ease;
        }
        .reference-card:hover {
          background: #F5F3FF;
        }
        .reference-card__translation {
          font-size: 15px;
          line-height: 1.8;
          font-style: italic;
          font-family: Georgia, 'Times New Roman', serif;
          color: #1a1a1a;
          margin: 8px 0;
        }
        .reference-card__purport {
          font-size: 13px;
          line-height: 1.7;
          color: #555;
          margin: 8px 0;
        }
        .reference-card__links {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-top: 8px;
        }
        .reference-card__links a {
          font-size: 12px;
          font-weight: 500;
          text-decoration: none;
          transition: text-decoration 0.2s;
        }
        .reference-card__links a:hover {
          text-decoration: underline;
        }

        @media (max-width: 768px) {
          .view-mode-toggle button {
            padding: 10px 16px;
            font-size: 14px;
          }
          /* Phone-first: give reference text more width, and keep the matched-line
             glow gentle where sentences wrap across more lines on narrow screens. */
          .reference-card { padding: 14px 16px; }
          .hl-sentence { box-shadow: 0 1px 9px rgba(139, 92, 246, 0.09); }
        }
        @media (max-width: 480px) {
          .reference-card { padding: 12px 14px; }
        }

        /* Quote block cursor */
        .narrative-content .verse-quote,
        .narrative-content .purport-quote,
        .narrative-content .prose-quote,
        .narrative-content .lecture-quote,
        .narrative-content .letter-quote {
          cursor: default;
        }

        /* ─── Premium Quote Tooltip Animations ─── */
        @keyframes tooltipElasticIn {
          0% {
            opacity: 0;
            transform: translateX(-100%) translateY(-50%) translateX(16px) scale(0.85);
          }
          40% {
            opacity: 1;
            transform: translateX(-100%) translateY(-50%) translateX(-5px) scale(1.04);
          }
          65% {
            transform: translateX(-100%) translateY(-50%) translateX(2px) scale(0.98);
          }
          85% {
            transform: translateX(-100%) translateY(-50%) translateX(-1px) scale(1.01);
          }
          100% {
            opacity: 1;
            transform: translateX(-100%) translateY(-50%) translateX(0) scale(1);
          }
        }

        @keyframes tooltipLineGrow {
          0% {
            transform: scaleX(0);
            opacity: 0;
          }
          60% {
            opacity: 1;
          }
          100% {
            transform: scaleX(1);
            opacity: 1;
          }
        }

        @keyframes tooltipDotPop {
          0% {
            transform: scale(0);
          }
          50% {
            transform: scale(1.8);
          }
          75% {
            transform: scale(0.85);
          }
          100% {
            transform: scale(1);
          }
        }

        @keyframes tooltipShimmer {
          0% {
            left: -100%;
          }
          100% {
            left: 200%;
          }
        }
      `}</style>
    </>
  );
}