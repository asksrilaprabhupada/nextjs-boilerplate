"use client";

import { motion } from "framer-motion";
import VerseBlock from "./VerseBlock";
import PurportBlock from "./PurportBlock";

export interface VerseResult {
  id: string;
  scripture: string;
  verse_number: string;
  sanskrit_devanagari: string;
  transliteration: string;
  translation: string;
  purport: string;
  chapter_number?: string;
  canto_or_division?: string;
  chapter_title?: string;
}

interface ScriptureLayerProps {
  scripture: "BG" | "SB" | "CC";
  verses: VerseResult[];
  narrativeIntro: string;
  narrativeConnectors: string[];
  visible: boolean;
}

const scriptureConfig = {
  BG: {
    label: "FROM BHAGAVAD GĪTĀ AS IT IS",
    iconGradient: "linear-gradient(135deg, var(--gold), var(--saffron))",
  },
  SB: {
    label: "FROM ŚRĪMAD BHĀGAVATAM",
    iconGradient: "linear-gradient(135deg, var(--saffron), var(--rose-gold))",
  },
  CC: {
    label: "FROM ŚRĪ CAITANYA CARITĀMṚTA",
    iconGradient: "linear-gradient(135deg, var(--temple-red), var(--lotus-pink))",
  },
};

function formatVerseRef(verse: VerseResult): string {
  const prefix = verse.scripture === "BG" ? "BG" : verse.scripture === "SB" ? "SB" : "CC";
  const canto = verse.canto_or_division ? `${verse.canto_or_division}.` : "";
  const ch = verse.chapter_number || "";
  return `${prefix} ${canto}${ch}.${verse.verse_number}`;
}

function truncatePurport(purport: string, maxLen = 800): string {
  if (!purport || purport.length <= maxLen) return purport;
  const truncated = purport.substring(0, maxLen);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxLen * 0.5 ? truncated.substring(0, lastPeriod + 1) : truncated + "...";
}

export default function ScriptureLayer({
  scripture,
  verses,
  narrativeIntro,
  narrativeConnectors,
  visible,
}: ScriptureLayerProps) {
  const config = scriptureConfig[scripture];

  if (!visible || verses.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      style={{
        background: "var(--bg-deepest)",
        width: "100%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "48px clamp(20px, 4vw, 40px)",
        }}
      >
        {/* Scripture section card */}
        <div
          style={{
            background: "var(--card-bg)",
            borderRadius: "var(--card-radius)",
            border: "1px solid var(--card-border)",
            boxShadow: "var(--card-shadow)",
            padding: "32px clamp(20px, 3vw, 32px)",
          }}
        >
          {/* Section marker */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: config.iconGradient,
                flexShrink: 0,
              }}
            />
            <span
              className="font-dm-sans"
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
              }}
            >
              {config.label}
            </span>
          </div>

          {/* Saffron underline */}
          <div
            style={{
              width: 60,
              height: 2,
              background: "var(--saffron)",
              marginBottom: 24,
              borderRadius: 1,
            }}
          />

          {/* Narrative intro */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="font-cormorant"
            style={{
              fontSize: "1.02rem",
              fontWeight: 400,
              lineHeight: 1.8,
              color: "var(--text-secondary)",
              marginBottom: 24,
            }}
          >
            {narrativeIntro}
          </motion.p>

          {/* Verses and purports */}
          {verses.map((verse, i) => (
            <motion.div
              key={verse.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 + i * 0.15 }}
            >
              <VerseBlock
                sanskrit={verse.sanskrit_devanagari}
                translation={verse.translation}
                verseRef={formatVerseRef(verse)}
                verseId={verse.id}
              />

              {verse.purport && (
                <PurportBlock text={truncatePurport(verse.purport)} />
              )}

              {/* Connector text */}
              {narrativeConnectors[i] && (
                <p
                  className="font-cormorant"
                  style={{
                    fontSize: "1.02rem",
                    fontWeight: 400,
                    lineHeight: 1.8,
                    color: "var(--text-secondary)",
                    margin: "20px 0",
                  }}
                >
                  {narrativeConnectors[i]}
                </p>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </motion.section>
  );
}
