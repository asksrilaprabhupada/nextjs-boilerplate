"use client";

import { useState, useRef, useEffect } from "react";

const topicPills = [
  "What is sadhu sanga?",
  "How to control the mind?",
  "What is karma?",
  "The nature of the soul",
  "What happens after death?",
  "What is pure devotional service?",
  "How to be free from suffering?",
  "What is the purpose of life?",
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [animatedIn, setAnimatedIn] = useState(false);

  useEffect(() => { if (hasResults) setHeroVisible(false); }, [hasResults]);
  useEffect(() => { const t = setTimeout(() => setAnimatedIn(true), 100); return () => clearTimeout(t); }, []);
  useEffect(() => { if (currentQuery) setQuery(currentQuery); }, [currentQuery]);

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (query.trim()) onSearch(query.trim()); };
  const handlePillClick = (topic: string) => { setQuery(topic); onSearch(topic); };

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
      {heroVisible && <div style={{ position: "absolute", top: "25%", left: "50%", transform: "translateX(-50%)", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.26) 0%, rgba(244,114,182,0.12) 42%, rgba(251,191,36,0.09) 72%, transparent 100%)", filter: "blur(72px)", animation: "floatOrb 20s ease-in-out infinite", pointerEvents: "none" }} />}

      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: heroVisible ? 700 : 700 }}>
        {heroVisible && (
          <div className="font-body" style={{ ...stagger(0), display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 16px 6px 10px", borderRadius: 100, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(196,181,253,0.3)", marginBottom: 32 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#8B5CF6", animation: "pulseDot 2.5s ease-in-out infinite" }} />
            <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.15em", color: "#7C3AED" }}>27 books · 59,000+ searchable entries</span>
          </div>
        )}
        {heroVisible && <h1 className="font-display" style={{ ...stagger(1), fontSize: "clamp(48px, 7vw, 88px)", fontWeight: 600, textAlign: "center", letterSpacing: "-0.03em", lineHeight: 1.05, marginBottom: 24, color: "#1E1B4B" }}>Ask anything to Śrīla Prabhupāda</h1>}
        {heroVisible && <p className="font-body" style={{ ...stagger(2), fontSize: "clamp(16px, 1.8vw, 17px)", fontWeight: 400, color: "#4B5563", textAlign: "center", maxWidth: 540, lineHeight: 1.7, marginBottom: 28 }}>Search across all 27 books — Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, Kṛṣṇa Book, and more. AI-powered answers from Prabhupāda&apos;s actual words.</p>}

        <form onSubmit={handleSubmit} style={{ ...stagger(3), width: "100%", maxWidth: 680, position: "relative", ...(hasResults ? { position: "sticky" as const, top: 68, zIndex: 50 } : {}) }}>
          <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Ask anything about the scriptures..." aria-label="Search" className="font-body" style={{ width: "100%", padding: "16px 54px 16px 22px", fontSize: 16, fontWeight: 400, border: "1px solid rgba(196,181,253,0.3)", borderRadius: 14, background: "rgba(255,255,255,0.9)", backdropFilter: "blur(20px)", color: "#1E1B4B", outline: "none", transition: "border-color 0.3s, box-shadow 0.3s", boxShadow: "0 14px 28px rgba(111,74,177,0.12)" }}
            onFocus={e => { e.currentTarget.style.borderColor = "#8B5CF6"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(139,92,246,0.12), 0 4px 24px rgba(139,92,246,0.06)"; }}
            onBlur={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; e.currentTarget.style.boxShadow = "0 4px 24px rgba(139,92,246,0.06)"; }}
          />
          <button type="submit" disabled={isSearching || !query.trim()} aria-label="Search" style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg, #8B5CF6, #7C3AED)", border: "none", cursor: query.trim() ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", opacity: query.trim() ? 1 : 0.4, transition: "transform 0.2s, opacity 0.2s" }}>
            {isSearching ? <svg width="16" height="16" viewBox="0 0 24 24" style={{ animation: "spin 0.8s linear infinite" }}><circle cx="12" cy="12" r="10" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray="30 70" /></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
        </form>

        {heroVisible && (
          <div style={{ ...stagger(4), display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 24, maxWidth: 680 }}>
            {topicPills.map(pill => (
              <button key={pill} onClick={() => handlePillClick(pill)} className="font-body" style={{ padding: "7px 16px", borderRadius: 100, border: "1px solid rgba(196,181,253,0.3)", background: "rgba(255,255,255,0.76)", fontSize: 13, fontWeight: 400, color: "#6B7280", cursor: "pointer", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)", whiteSpace: "nowrap", backdropFilter: "blur(10px)" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#C4B5FD"; e.currentTarget.style.color = "#7C3AED"; e.currentTarget.style.background = "rgba(139,92,246,0.08)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; e.currentTarget.style.color = "#6B7280"; e.currentTarget.style.background = "rgba(255,255,255,0.76)"; e.currentTarget.style.transform = "translateY(0)"; }}
              >{pill}</button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}