/**
 * 01-hero-search.tsx — Hero Search Bar
 *
 * Renders the main search input with animated placeholder, voice input, example questions, and search progress indicator.
 * This is the primary entry point for users to ask questions to Srila Prabhupada's teachings.
 */
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import TypewriterPlaceholder from "./02-typewriter-placeholder";
import SearchProgress from "./05-search-progress";
import VoiceInput from "./03-voice-input";
import ExamplesPopover from "./04-examples-popover";

interface HeroSearchProps {
  onSearch: (query: string) => void;
  onClear?: () => void;
  isSearching: boolean;
  hasResults: boolean;
  currentQuery?: string;
  progressRef?: React.RefObject<HTMLDivElement | null>;
}

export default function HeroSearch({ onSearch, onClear, isSearching, hasResults, currentQuery, progressRef }: HeroSearchProps) {
  const [query, setQuery] = useState("");
  const [heroVisible, setHeroVisible] = useState(true);
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [animatedIn, setAnimatedIn] = useState(false);

  useEffect(() => { if (hasResults) setHeroVisible(false); }, [hasResults]);
  // Reset hero when results are cleared
  useEffect(() => { if (!hasResults && !isSearching) setHeroVisible(true); }, [hasResults, isSearching]);
  useEffect(() => { const t = setTimeout(() => setAnimatedIn(true), 100); return () => clearTimeout(t); }, []);
  useEffect(() => { if (currentQuery) setQuery(currentQuery); }, [currentQuery]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  useEffect(() => { autoResize(); }, [query, autoResize]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (query.trim()) onSearch(query.trim()); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (query.trim()) onSearch(query.trim());
    }
  };

  const handleClear = () => {
    setQuery("");
    setIsFocused(false);
    // Tell parent to reset search results → brings back the hero
    if (onClear) onClear();
  };

  const handleVoiceTranscript = useCallback((text: string) => { setQuery(text); setIsFocused(true); }, []);
  const handleVoiceFinal = useCallback((text: string) => { setQuery(text); setIsFocused(true); textareaRef.current?.focus(); }, []);

  const handleExampleSelect = useCallback((text: string) => {
    setQuery(text);
    setIsFocused(true);
    textareaRef.current?.focus();
  }, []);

  const stagger = (i: number) => ({
    opacity: animatedIn ? 1 : 0,
    transform: animatedIn ? "translateY(0)" : "translateY(32px)",
    transition: `opacity 0.8s cubic-bezier(0.16,1,0.3,1) ${i * 100}ms, transform 0.8s cubic-bezier(0.16,1,0.3,1) ${i * 100}ms`,
  });

  // When clear button is visible we need more right padding to avoid text collision
  const showClearBtn = hasResults && query;
  // Minimum 100px right padding so text never goes behind mic + submit buttons
  const inputRightPadding = showClearBtn ? "clamp(140px, 20vw, 160px)" : "clamp(100px, 16vw, 120px)";

  return (
    <section style={{
      minHeight: heroVisible ? "100vh" : "auto",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: heroVisible ? "center" : "flex-start",
      padding: heroVisible ? "60px clamp(16px, 4vw, 80px) 40px" : "68px clamp(12px, 3vw, 20px) 16px",
      position: "relative", transition: "min-height 0.7s var(--ease-out-expo), padding 0.5s var(--ease-out-expo) 0.1s", overflow: "hidden",
    }}>
      {/* Background orb */}
      {heroVisible && <div style={{ position: "absolute", top: "25%", left: "50%", transform: "translateX(-50%)", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.26) 0%, rgba(244,114,182,0.12) 42%, rgba(251,191,36,0.09) 72%, transparent 100%)", filter: "blur(72px)", animation: "floatOrb 20s ease-in-out infinite", pointerEvents: "none" }} />}

      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: 700 }}>
        {/* Badge */}
        {heroVisible && (
          <div className="font-body" style={{ ...stagger(0), display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 16px 6px 10px", borderRadius: 100, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(196,181,253,0.3)", marginBottom: 24 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#8B5CF6", animation: "pulseDot 2.5s ease-in-out infinite" }} />
            <span style={{ fontSize: "clamp(10px, 2.5vw, 12px)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.10em", color: "#7C3AED" }}>36 books · 3,700+ lectures · 6,500+ letters</span>
          </div>
        )}

        {/* Title */}
        {heroVisible && <h1 className="font-display" style={{ ...stagger(1), fontSize: "clamp(38px, 7vw, 88px)", fontWeight: 600, textAlign: "center", letterSpacing: "-0.03em", lineHeight: 1.05, marginBottom: 16, color: "#1E1B4B", overflowWrap: "break-word" }}>Ask<br /><span style={{ background: "linear-gradient(135deg, #E8891C, #F5A623, #D4760A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>Śrīla Prabhupāda</span></h1>}

        {/* Subtitle */}
        {heroVisible && <p className="font-body" style={{ ...stagger(2), fontSize: "clamp(15px, 1.6vw, 17px)", fontWeight: 400, color: "#374151", textAlign: "center", maxWidth: 540, lineHeight: 1.65, marginBottom: 22 }}>Search across 36 books, 3,700 lectures, and 6,500 letters — every answer drawn directly from his translations, purports, and personal correspondence. Nothing added, nothing invented.</p>}

        {/* Search form */}
        <form
          onSubmit={handleSubmit}
          className="hero-search-form"
          style={{
            ...stagger(3),
            width: "100%",
            maxWidth: 680,
            position: "relative",
            ...(hasResults ? { position: "sticky" as const, top: 68, zIndex: 50 } : {}),
          }}
        >
          <div className="hero-search-wrapper" style={{ position: "relative" }}>
            <textarea
              ref={textareaRef}
              value={query}
              onChange={e => { setQuery(e.target.value); }}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => { if (!query) setIsFocused(false); }}
              placeholder=""
              aria-label="Search Prabhupāda's books"
              className="font-body hero-search-input"
              rows={1}
              style={{
                width: "100%",
                padding: `18px ${inputRightPadding} 18px clamp(16px, 3vw, 24px)`,
                fontSize: "clamp(15px, 2.8vw, 17px)",
                fontWeight: 400,
                border: "none",
                borderRadius: 18,
                background: "rgba(255,255,255,0.85)",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
                color: "#1E1B4B",
                outline: "none",
                transition: "box-shadow 0.3s",
                boxShadow: isFocused
                  ? "0 0 0 3px rgba(139,92,246,0.12), 0 4px 24px rgba(139,92,246,0.08)"
                  : "0 8px 32px rgba(111,74,177,0.14), 0 0 60px rgba(139,92,246,0.04)",
                resize: "none",
                overflow: "hidden",
                lineHeight: "1.5",
                fontFamily: "inherit",
              }}
            />

            {/* Typewriter placeholder when input is empty and not focused */}
            {!query && <TypewriterPlaceholder isFocused={isFocused} />}

            {/* Static placeholder when focused but empty */}
            {!query && isFocused && (
              <span
                className="font-body"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 24,
                  top: 20,
                  right: 100,
                  fontSize: "clamp(15px, 2.8vw, 17px)",
                  color: "#C4B5FD",
                  pointerEvents: "none",
                  lineHeight: "1.5",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                Ask anything about the scriptures...
              </span>
            )}

            {/* Clear button — only when results exist and there's a query */}
            {showClearBtn && (
              <button
                type="button"
                onClick={handleClear}
                aria-label="Clear search and go home"
                className="hero-clear-btn"
                style={{
                  position: "absolute",
                  right: 96,
                  top: 14,
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "rgba(139,92,246,0.08)",
                  border: "1px solid rgba(196,181,253,0.3)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.2s ease",
                  color: "#6B7280",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.15)"; e.currentTarget.style.color = "#7C3AED"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(139,92,246,0.08)"; e.currentTarget.style.color = "#6B7280"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}

            {/* Voice input button */}
            <div className="hero-voice-btn" style={{ position: "absolute", right: 54, top: 12 }}>
              <VoiceInput
                onTranscript={handleVoiceTranscript}
                onFinalTranscript={handleVoiceFinal}
                disabled={isSearching}
              />
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={isSearching || !query.trim()}
              aria-label="Search"
              className="hero-submit-btn"
              style={{
                position: "absolute",
                right: 8,
                top: 10,
                width: 42,
                height: 42,
                borderRadius: 12,
                background: "linear-gradient(135deg, #7C3AED, #6D28D9)",
                border: "none",
                cursor: query.trim() ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: query.trim() ? 1 : 0.4,
                transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                boxShadow: query.trim() ? "0 4px 14px rgba(139,92,246,0.3)" : "none",
              }}
              onMouseEnter={e => { if (query.trim()) { e.currentTarget.style.transform = "scale(1.08)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(139,92,246,0.4)"; } }}
              onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = query.trim() ? "0 4px 14px rgba(139,92,246,0.3)" : "none"; }}
            >
              {isSearching ? (
                <svg width="18" height="18" viewBox="0 0 24 24" style={{ animation: "spin 0.8s linear infinite" }}>
                  <circle cx="12" cy="12" r="10" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray="30 70" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M12 5l7 7-7 7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>

          {/* Gradient line under sticky bar */}
          {hasResults && (
            <div style={{
              position: "absolute",
              bottom: -6,
              left: "10%",
              right: "10%",
              height: 2,
              borderRadius: 1,
              background: "linear-gradient(90deg, transparent, rgba(139,92,246,0.3), rgba(196,181,253,0.5), rgba(139,92,246,0.3), transparent)",
            }} />
          )}
        </form>

        {/* Example pills — visible below search bar */}
        {heroVisible && (
          <div style={{ ...stagger(4), marginTop: 16 }}>
            <ExamplesPopover onSelect={handleExampleSelect} />
          </div>
        )}
      </div>

      {/* Search Progress */}
      {isSearching && (
        <div ref={progressRef}>
          <SearchProgress isSearching={isSearching} />
        </div>
      )}
    </section>
  );
}
