/**
 * generate-article/route.ts — Quarantined AI endpoint
 *
 * The live search builds the woven essay from a deterministic, verbatim-only
 * template (see buildTemplateArticle in api/search/route.ts). The former AI
 * article generator has been QUARANTINED: the POST endpoint is disabled so no
 * AI-authored narrative can ever be produced (Hard Rule 1 — never generate
 * Prabhupāda's philosophy). The coarse per-canto speaker map that used to live
 * here is gone: verse story speakers now come solely from uvāca markers
 * (app/lib/14-verse-speaker.ts) and are never guessed.
 */
import { NextResponse } from "next/server";

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
