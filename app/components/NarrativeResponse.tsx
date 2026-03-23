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
            border: "2px solid var(--border-medium)",
            borderTopColor: "var(--saffron)",
            animation: "rotate-mandala 1s linear infinite",
          }}
        />
        <p
          className="font-cormorant"
          style={{
            fontSize: "1.02rem",
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
      {/* Layer 1: Bhagavad Gītā */}
      <ScriptureLayer
        scripture="BG"
        verses={results.bg.verses}
        narrativeIntro={results.bg.narrativeIntro}
        narrativeConnectors={results.bg.narrativeConnectors}
        visible={true}
      />

      {/* Go Deeper to SB */}
      {hasSB && !showSB && (
        <div style={{ background: "var(--bg-deepest)" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 clamp(20px, 4vw, 40px)" }}>
            <GoDeeper
              transitionText="Śrīmad Bhāgavatam expands further on this topic with greater depth and detail..."
              onClick={() => setShowSB(true)}
            />
          </div>
        </div>
      )}

      {/* Layer 2: Śrīmad Bhāgavatam */}
      <ScriptureLayer
        scripture="SB"
        verses={results.sb.verses}
        narrativeIntro={results.sb.narrativeIntro}
        narrativeConnectors={results.sb.narrativeConnectors}
        visible={showSB}
      />

      {/* Go Deeper to CC */}
      {hasCC && showSB && !showCC && (
        <div style={{ background: "var(--bg-deepest)" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 clamp(20px, 4vw, 40px)" }}>
            <GoDeeper
              transitionText="Caitanya Caritāmṛta reveals the highest understanding of this topic through the teachings of Lord Caitanya..."
              onClick={() => setShowCC(true)}
            />
          </div>
        </div>
      )}

      {/* Layer 3: Caitanya Caritāmṛta */}
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
