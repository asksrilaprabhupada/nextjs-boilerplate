/**
 * generate-summary/route.ts — Key Answers Summary Generator
 *
 * Accepts an array of scripture passages and returns a one-line summary for each,
 * powered by Claude. Used by the search results sidebar to show key answers.
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: NextRequest) {
  try {
    const { passages } = await request.json();

    if (!passages || !Array.isArray(passages) || passages.length === 0) {
      return Response.json({ summaries: [] });
    }

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `Summarize scripture passages. For each, write ONE line (max 15 words) stating what the verse says. No interpretation. No quotes. Return ONLY a JSON array of strings. No preamble, no markdown.`,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            passages.map((p: { reference: string; text: string }) => ({
              ref: p.reference,
              text: p.text.slice(0, 300),
            }))
          ),
        },
      ],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    try {
      return Response.json({ summaries: JSON.parse(text.trim()) });
    } catch {
      return Response.json({
        summaries: passages.map(() => "View this passage"),
      });
    }
  } catch (err) {
    console.error("Summary generation error:", err);
    return Response.json({
      summaries: [],
      error: "Failed to generate summaries",
    });
  }
}
