/**
 * generate-article/route.ts — Speaker attribution helper (+ disabled AI endpoint)
 *
 * The live search now builds the woven essay from a deterministic, verbatim-only
 * template (see buildTemplateArticle in api/search/route.ts). The former AI
 * article generator has been QUARANTINED: the POST endpoint is disabled so no
 * AI-authored narrative can ever be produced (Hard Rule 1 — never generate
 * Prabhupāda's philosophy). This module now exists only to export getSpeaker,
 * the neutral speaker-attribution helper the search route imports.
 */
import { NextResponse } from "next/server";

/* ─── Speaker attribution map ─── */
const SPEAKERS: Record<string, string> = {
  "BG": "Lord Krsna",
  "SB 1": "Suta Gosvami",
  "SB 2": "Sukadeva Gosvami",
  "SB 3": "Maitreya Rsi",
  "SB 4": "Maitreya Rsi",
  "SB 5": "Sukadeva Gosvami",
  "SB 6": "Sukadeva Gosvami",
  "SB 7": "Narada Muni",
  "SB 8": "Sukadeva Gosvami",
  "SB 9": "Sukadeva Gosvami",
  "SB 10": "Sukadeva Gosvami",
  "SB 11": "Lord Krsna to Uddhava",
  "SB 12": "Sukadeva Gosvami",
  "CC": "Krsnadasa Kaviraja Gosvami",
  "NOI": "Srila Rupa Gosvami",
  "ISO": "Sri Isopanisad",
  "BS": "Lord Brahma",
};

/* ─── BG verse-specific speaker overrides ─── */
const ARJUNA_BG_VERSES = new Set([
  // Chapter 1 (Arjuna's despair)
  ...Array.from({ length: 27 }, (_, i) => `BG ${1}.${i + 21}`),
  // Chapter 2 (Arjuna's surrender)
  "BG 2.4", "BG 2.5", "BG 2.6",
  // Chapter 3
  "BG 3.1", "BG 3.2", "BG 3.36",
  // Chapter 4
  "BG 4.4",
  // Chapter 5
  "BG 5.1",
  // Chapter 6 (Arjuna's doubt about mind control)
  "BG 6.33", "BG 6.34", "BG 6.37", "BG 6.38", "BG 6.39",
  // Chapter 8
  "BG 8.1", "BG 8.2",
  // Chapter 11 (Arjuna's vision)
  ...Array.from({ length: 20 }, (_, i) => `BG ${11}.${i + 15}`),
  "BG 11.36", "BG 11.37", "BG 11.38", "BG 11.39", "BG 11.40",
  "BG 11.41", "BG 11.42", "BG 11.44", "BG 11.45", "BG 11.46",
  // Chapter 12
  "BG 12.1",
  // Chapter 17
  "BG 17.1",
  // Chapter 18
  "BG 18.1", "BG 18.73",
]);

const SANJAYA_BG_VERSES = new Set([
  "BG 1.1", "BG 1.2", "BG 1.19", "BG 1.20",
  "BG 2.1", "BG 2.9", "BG 2.10",
  "BG 11.9", "BG 11.10", "BG 11.11", "BG 11.12", "BG 11.13", "BG 11.14",
  "BG 11.35", "BG 11.49", "BG 11.50",
  "BG 18.74", "BG 18.75", "BG 18.76", "BG 18.77", "BG 18.78",
]);

function getSpeaker(ref: string, type: string): string {
  if (type === "purport") return "Srila Prabhupada";

  // Normalize ref to "BG X.Y" format for lookup
  const normalizedRef = ref.replace(/\s+/g, " ").trim();

  // Check BG-specific speakers
  if (ARJUNA_BG_VERSES.has(normalizedRef)) return "Arjuna";
  if (SANJAYA_BG_VERSES.has(normalizedRef)) return "Sañjaya";

  const parts = ref.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const k = parts.slice(0, i).join(".");
    if (SPEAKERS[k]) return SPEAKERS[k];
  }
  const spaceKey = ref.split(".")[0];
  if (SPEAKERS[spaceKey]) return SPEAKERS[spaceKey];
  const firstWord = ref.split(" ")[0];
  if (SPEAKERS[firstWord]) return SPEAKERS[firstWord];
  return "the scripture";
}

export { getSpeaker };

/**
 * QUARANTINED. AI narrative generation is permanently disabled: the woven essay
 * is built exclusively from the deterministic, verbatim-only template. This
 * endpoint never calls a model and never returns generated prose.
 */
export async function POST() {
  return NextResponse.json(
    { article: "", disabled: "AI article generation is disabled; the essay is built from verbatim passages only." },
    { status: 410 },
  );
}
