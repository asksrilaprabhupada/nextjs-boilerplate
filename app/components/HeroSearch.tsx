"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import TypewriterPlaceholder from "./TypewriterPlaceholder";
import SearchProgress from "./SearchProgress";
import VoiceInput from "./VoiceInput";

const topicPills = [
  { emoji: "🕉️", text: "What is sadhu sanga?" },
  { emoji: "🧘", text: "How to control the mind?" },
  { emoji: "☸️", text: "What is karma?" },
  { emoji: "✨", text: "The nature of the soul" },
  { emoji: "🪷", text: "What happens after death?" },
  { emoji: "💛", text: "What is pure devotional service?" },
  { emoji: "🙏", text: "How to be free from suffering?" },
  { emoji: "🌸", text: "What is the purpose of life?" },
];

interface HeroSearchProps {
  onSearch: (query: string) => void;
  isSearching: boolean;
  hasResults: boolean;
  currentQuery?: string;
}

export default function HeroSearch({ onSearch, isSearching, hasResults, currentQuery }: HeroSearchProps) {
  const [query, setQuery] = useState("");
  const [heroVisible, setHeroVisible] = useState(true);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [animatedIn, setAnimatedIn] = useState(false);

  useEffect(() => { if (hasResults) setHeroVisible(false); }, [hasResults]);
  useEffect(() => { const t = setTimeout(() => setAnimatedIn(true), 100); return () => clearTimeout(t); }, []);
  useEffect(() => { if (currentQuery) setQuery(currentQuery); }, [currentQuery]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (query.trim()) onSearch(query.trim()); };
  const handlePillClick = (topic: string) => { setQuery(topic); onSearch(topic); };
  const handleClear = () => { setQuery(""); setIsFocused(false); };
  const handleVoiceTranscript = useCallback((text: string) => { setQuery(text); setIsFocused(true); }, []);
  const handleVoiceFinal = useCallback((text: string) => { setQuery(text); setIsFocused(true); inputRef.current?.focus(); }, []);

  const stagger = (i: number) => ({
    opacity: animatedIn ? 1 : 0,
    transform: animatedIn ? "translateY(0)" : "translateY(32px)",
    transition: `opacity 0.8s cubic-bezier(0.16,1,0.3,1) ${i * 100}ms, transform 0.8s cubic-bezier(0.16,1,0.3,1) ${i * 100}ms`,
  });

  return (
    <section style={{
      minHeight: heroVisible ? "100vh" : "auto",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: heroVisible ? "center" : "flex-start",
      padding: heroVisible ? "80px clamp(20px, 4vw, 80px) 60px" : "76px 20px 20px",
      position: "relative", transition: "all 0.6s var(--ease-out-expo)", overflow: "hidden",
    }}>
      {/* Background orb */}
      {heroVisible && <div style={{ position: "absolute", top: "25%", left: "50%", transform: "translateX(-50%)", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.26) 0%, rgba(244,114,182,0.12) 42%, rgba(251,191,36,0.09) 72%, transparent 100%)", filter: "blur(72px)", animation: "floatOrb 20s ease-in-out infinite", pointerEvents: "none" }} />}

      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: 700 }}>
        {/* Badge */}
        {heroVisible && (
          <div className="font-body" style={{ ...stagger(0), display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 16px 6px 10px", borderRadius: 100, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(196,181,253,0.3)", marginBottom: 32 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#8B5CF6", animation: "pulseDot 2.5s ease-in-out infinite" }} />
            <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.10em", color: "#7C3AED" }}>27 books · 59,000+ searchable entries</span>
          </div>
        )}

        {/* Title */}
        {heroVisible && <h1 className="font-display" style={{ ...stagger(1), fontSize: "clamp(48px, 7vw, 88px)", fontWeight: 600, textAlign: "center", letterSpacing: "-0.03em", lineHeight: 1.05, marginBottom: 24, color: "#1E1B4B" }}>Ask{" "}<span style={{ background: "linear-gradient(135deg, #E8891C, #F5A623, #D4760A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>Śrīla Prabhupāda</span></h1>}

        {/* Subtitle */}
        {heroVisible && <p className="font-body" style={{ ...stagger(2), fontSize: "clamp(16px, 1.8vw, 17px)", fontWeight: 400, color: "#374151", textAlign: "center", maxWidth: 540, lineHeight: 1.7, marginBottom: 28 }}>Search across all 27 books — Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, Kṛṣṇa Book, and more. AI-powered answers from Prabhupāda&apos;s actual words.</p>}

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
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => { if (!query) setIsFocused(false); }}
              placeholder=""
              aria-label="Search Prabhupāda's books"
              className="font-body hero-search-input"
              style={{
                width: "100%",
                padding: "20px 160px 20px 24px",
                fontSize: 17,
                fontWeight: 400,
                border: "1.5px solid rgba(196,181,253,0.5)",
                borderRadius: 18,
                background: "rgba(255,255,255,0.85)",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
                color: "#1E1B4B",
                outline: "none",
                transition: "border-color 0.3s, box-shadow 0.3s",
                boxShadow: isFocused
                  ? "0 0 0 3px rgba(139,92,246,0.12), 0 4px 24px rgba(139,92,246,0.08)"
                  : "0 8px 32px rgba(111,74,177,0.14), 0 0 60px rgba(139,92,246,0.04)",
                borderColor: isFocused ? "#8B5CF6" : "rgba(196,181,253,0.5)",
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
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 17,
                  color: "#C4B5FD",
                  pointerEvents: "none",
                }}
              >
                Ask anything about the scriptures...
              </span>
            )}

            {/* Clear button (post-search) */}
            {hasResults && query && (
              <button
                type="button"
                onClick={handleClear}
                aria-label="Clear search"
                className="hero-clear-btn"
                style={{
                  position: "absolute",
                  right: 104,
                  top: "50%",
                  transform: "translateY(-50%)",
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
            <div style={{ position: "absolute", right: 54, top: "50%", transform: "translateY(-50%)" }}>
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
                top: "50%",
                transform: "translateY(-50%)",
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
              onMouseEnter={e => { if (query.trim()) { e.currentTarget.style.transform = "translateY(-50%) scale(1.08)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(139,92,246,0.4)"; } }}
              onMouseLeave={e => { e.currentTarget.style.transform = "translateY(-50%) scale(1)"; e.currentTarget.style.boxShadow = query.trim() ? "0 4px 14px rgba(139,92,246,0.3)" : "none"; }}
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

        {/* Topic pills */}
        {heroVisible && (
          <div
            className="topic-pills-container"
            style={{
              ...stagger(4),
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              marginTop: 28,
              maxWidth: 680,
            }}
          >
            {topicPills.map(pill => (
              <button
                key={pill.text}
                onClick={() => handlePillClick(pill.text)}
                className="font-body topic-pill"
                style={{
                  padding: "8px 18px",
                  borderRadius: 100,
                  border: "1px solid rgba(196,181,253,0.3)",
                  background: "rgba(255,255,255,0.76)",
                  fontSize: 13,
                  fontWeight: 400,
                  color: "#6B7280",
                  cursor: "pointer",
                  transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)",
                  whiteSpace: "nowrap",
                  backdropFilter: "blur(10px)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = "#C4B5FD";
                  e.currentTarget.style.color = "#7C3AED";
                  e.currentTarget.style.background = "rgba(139,92,246,0.1)";
                  e.currentTarget.style.transform = "translateY(-3px) scale(1.02)";
                  e.currentTarget.style.boxShadow = "0 6px 20px rgba(139,92,246,0.12)";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
                  e.currentTarget.style.color = "#6B7280";
                  e.currentTarget.style.background = "rgba(255,255,255,0.76)";
                  e.currentTarget.style.transform = "translateY(0) scale(1)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <span style={{ fontSize: 14 }}>{pill.emoji}</span>
                {pill.text}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search Progress (replaces spinner during search) */}
      {isSearching && <SearchProgress isSearching={isSearching} />}
    </section>
  );
}
