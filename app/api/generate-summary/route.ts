/**
 * generate-summary/route.ts — Key Answers Summary Generator
 *
 * Accepts an array of scripture passages and returns a one-line summary for each,
 * powered by Gemini 2.5 Flash Lite (cheapest model). Used by the search results
 * sidebar to show key answers.
 */
import { NextRequest, NextResponse } from "next/server";

const geminiKey = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

async function callGemini(prompt: string): Promise<string> {
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
        generationConfig: {
          maxOutputTokens: 1000,
          temperature: 0.2,
          responseMimeType: "application/json",
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
      console.error("Gemini summary API error:", res.status, await res.text());
      return "";
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (err) {
    console.error("Gemini summary call failed:", err);
    return "";
  }
}

export async function POST(request: NextRequest) {
  try {
    const { passages } = await request.json();

    if (!passages || !Array.isArray(passages) || passages.length === 0) {
      return NextResponse.json({ summaries: [] });
    }

    const passageList = passages
      .map((p: { reference: string; text: string }, i: number) =>
        `${i + 1}. [${p.reference}] "${(p.text || "").slice(0, 300)}"`
      )
      .join("\n");

    const prompt = `You summarize scripture passages from Srila Prabhupada's books.

For each passage below, write ONE short summary line (maximum 15 words) stating what the verse teaches. Rules:
- No interpretation or commentary — just state what the passage says
- No quotation marks in summaries
- Return ONLY a JSON array of strings, same order as input
- Example: ["Devotional service begins with hearing and chanting about Krishna", "The soul is eternal and never destroyed"]

Passages:
${passageList}`;

    const raw = await callGemini(prompt);

    if (!raw) {
      return NextResponse.json({
        summaries: passages.map(() => "View this passage"),
      });
    }

    try {
      // Clean any markdown fencing the model might add
      const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
      const summaries = JSON.parse(cleaned);

      if (Array.isArray(summaries) && summaries.length > 0) {
        return NextResponse.json({ summaries });
      }
    } catch {
      // JSON parse failed
    }

    return NextResponse.json({
      summaries: passages.map(() => "View this passage"),
    });
  } catch (err) {
    console.error("Summary generation error:", err);
    return NextResponse.json({
      summaries: [],
      error: "Failed to generate summaries",
    });
  }
}
