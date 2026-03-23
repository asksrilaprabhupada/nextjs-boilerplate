"use client";

import { useState } from "react";
import ScriptureLayer, { VerseResult } from "./ScriptureLayer";
import GoDeeper from "./GoDeeper";

export interface SearchResults {
  bg: {
    verses: VerseResult[];
    narrativeIntro: string;
    narrativeConnectors: string[];
  };
  sb: {
    verses: VerseResult[];
    narrativeIntro: string;
    narrativeConnectors: string[];
  };
  cc: {
    verses: VerseResult[];
    narrativeIntro: string;
    narrativeConnectors: string[];
  };
}

interface NarrativeResponseProps {
  results: SearchResults | null;
  isLoading: boolean;
}

export default function NarrativeResponse({ results, isLoading }: NarrativeResponseProps) {
  const [showSB, setShowSB] = useState(false);
  const [showCC, setShowCC] = useState(false);

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 20px",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: "2px solid var(--border-subtle)",
            borderTopColor: "var(--aurora-violet)",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <p
          className="font-display"
          style={{
            fontSize: "1.05rem",
            fontStyle: "italic",
            color: "var(--text-muted)",
          }}
        >
          Searching through the scriptures...
        </p>
      </div>
    );
  }

  if (!results) return null;

  const hasSB = results.sb.verses.length > 0;
  const hasCC = results.cc.verses.length > 0;

  return (
    <div style={{ width: "100%" }}>
      <ScriptureLayer
        scripture="BG"
        verses={results.bg.verses}
        narrativeIntro={results.bg.narrativeIntro}
        narrativeConnectors={results.bg.narrativeConnectors}
        visible={true}
      />

      {hasSB && !showSB && (
        <div style={{ background: "transparent" }}>
          <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 clamp(20px, 4vw, 40px)" }}>
            <GoDeeper
              transitionText="Śrīmad Bhāgavatam expands further on this topic with greater depth and detail..."
              onClick={() => setShowSB(true)}
            />
          </div>
        </div>
      )}

      <ScriptureLayer
        scripture="SB"
        verses={results.sb.verses}
        narrativeIntro={results.sb.narrativeIntro}
        narrativeConnectors={results.sb.narrativeConnectors}
        visible={showSB}
      />

      {hasCC && showSB && !showCC && (
        <div style={{ background: "transparent" }}>
          <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 clamp(20px, 4vw, 40px)" }}>
            <GoDeeper
              transitionText="Caitanya Caritāmṛta reveals the highest understanding of this topic through the teachings of Lord Caitanya..."
              onClick={() => setShowCC(true)}
            />
          </div>
        </div>
      )}

      <ScriptureLayer
        scripture="CC"
        verses={results.cc.verses}
        narrativeIntro={results.cc.narrativeIntro}
        narrativeConnectors={results.cc.narrativeConnectors}
        visible={showCC}
      />
    </div>
  );
}
