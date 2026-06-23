/**
 * 05-search-progress.tsx — Search "Settling" Indicator
 *
 * While a search runs, the page shows a single soft breathing violet light and one
 * calm line of text — the wait should feel like settling, not loading. The answer
 * then composes beneath the search bar as it lifts to the top. One accent (violet),
 * slow and soft; reduced-motion safe.
 */
"use client";

import { useState, useEffect } from "react";

const PHRASES = [
  "Listening to your question…",
  "Gathering Śrīla Prabhupāda's words…",
  "Letting the answer settle…",
];

interface SearchProgressProps {
  isSearching: boolean;
}

export default function SearchProgress({ isSearching }: SearchProgressProps) {
  const [phrase, setPhrase] = useState(0);

  useEffect(() => {
    if (!isSearching) {
      setPhrase(0);
      return;
    }
    const id = setInterval(() => setPhrase((p) => (p + 1) % PHRASES.length), 2600);
    return () => clearInterval(id);
  }, [isSearching]);

  if (!isSearching) return null;

  return (
    <div
      className="search-progress"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "64px 20px 44px",
        gap: 22,
      }}
    >
      {/* A single soft breathing light — calm, not a spinner. */}
      <div className="settling-orb" aria-hidden="true" />

      {/* One calm line, softly cycling. */}
      <p
        key={phrase}
        className="font-body settling-line"
        aria-live="polite"
        style={{ fontSize: 14, color: "#7C3AED", letterSpacing: "0.01em", margin: 0, textAlign: "center" }}
      >
        {PHRASES[phrase]}
      </p>

      <style jsx>{`
        .settling-orb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 50%,
            rgba(167, 139, 250, 0.55) 0%,
            rgba(139, 92, 246, 0.30) 45%,
            rgba(139, 92, 246, 0) 72%);
          animation: settleBreath 2.6s ease-in-out infinite;
        }
        @keyframes settleBreath {
          0%, 100% { transform: scale(0.84); opacity: 0.5; }
          50%      { transform: scale(1.14); opacity: 1; }
        }
        .settling-line {
          opacity: 0.9;
          animation: settleLineIn 0.8s ease both;
        }
        @keyframes settleLineIn {
          from { opacity: 0; }
          to   { opacity: 0.9; }
        }
        @media (prefers-reduced-motion: reduce) {
          .settling-orb { animation: none; opacity: 0.85; }
          .settling-line { animation: none; }
        }
      `}</style>
    </div>
  );
}
