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

function getSpeaker(ref: string, type: string): string {
  if (type === "purport") return "Srila Prabhupada";
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
