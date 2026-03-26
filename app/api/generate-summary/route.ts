/**
 * generate-summary/route.ts — AI Summary Generation
 *
 * Accepts an array of scripture passages and returns one-line summaries
 * for each passage using Claude. Used by the search results sidebar.
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  try {
    const { passages } = await request.json();

    if (!passages || !Array.isArray(passages) || passages.length === 0) {
      return NextResponse.json({ summaries: [] });
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
      return NextResponse.json({ summaries: JSON.parse(text.trim()) });
    } catch {
      return NextResponse.json({
        summaries: passages.map(() => "View this passage"),
      });
    }
  } catch (error) {
    console.error("Summary generation failed:", error);
    return NextResponse.json({
      summaries: [],
      error: "Failed to generate summaries",
    });
  }
}
