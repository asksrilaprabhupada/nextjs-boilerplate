/**
 * generate-article/route.ts — Article Mode Generation
 *
 * Accepts questions and scripture passages, returns a flowing article where
 * AI writes ONLY filler/transition sentences and all scripture is verbatim.
 * Uses Gemini 2.5 Flash Lite (cheapest model — fillers are simple tasks).
 */
import { NextResponse } from "next/server";

const geminiKey = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

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

async function callGemini(prompt: string, systemPrompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          maxOutputTokens: 4000,
          temperature: 0.3,
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
    });
    if (!res.ok) {
      console.error("Gemini article API error:", res.status, await res.text());
      return "";
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (err) {
    console.error("Gemini article call failed:", err);
    return "";
  }
}

export async function POST(request: Request) {
  try {
    const { questions, passages } = await request.json();

    if (!passages || !Array.isArray(passages) || passages.length === 0) {
      return NextResponse.json({ article: "" });
    }

    const systemPrompt = `You are an editor for a Vaishnava scripture website.
YOUR ONLY JOB: Write short filler sentences (1-2 each) connecting scripture passages.
WHAT FILLERS CAN DO:
- Identify speaker: "Lord Krsna instructs Uddhava...", "Sukadeva Gosvami narrates..."
- Provide context: "In the following verse..."
- Transition: "On a related note..."
- Distinguish translation from purport: "Srila Prabhupada explains in his purport..."
STRICT RULES:
- NEVER generate spiritual content
- NEVER paraphrase scripture
- Use passages EXACTLY as given
- Every passage in blockquote with reference: > "passage text" — [REFERENCE]
- Fillers are plain text. No headings. No numbered sections.
- Weave multiple questions together naturally
- 1-2 sentence intro, 1-2 sentence conclusion
OUTPUT: Only the article. No preamble.`;

    const userContent = `Questions: ${(questions || []).join(" ")}\n\nPassages:\n${
      passages
        .map(
          (p: { reference: string; type: string; speaker: string; text: string }, i: number) =>
            `--- ${i + 1} ---\nRef: ${p.reference}\nType: ${p.type}\nSpeaker: ${p.speaker}\nText: "${p.text}"`
        )
        .join("\n\n")
    }\n\nArrange into a flowing article using EVERY passage exactly as given.`;

    const article = await callGemini(userContent, systemPrompt);

    return NextResponse.json({ article });
  } catch (error) {
    console.error("Article generation failed:", error);
    return NextResponse.json(
      { article: "", error: "Failed to generate article" },
      { status: 500 }
    );
  }
}
