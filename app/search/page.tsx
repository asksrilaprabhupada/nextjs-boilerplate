/**
 * search/page.tsx — Search Results Page (dynamic)
 *
 * Thin server shell around the live search experience: reads `q` from the URL
 * server-side (so the question is in the served HTML), redirects to the home
 * search when empty, and hands off to the client <SearchExperience>, which
 * opens the /api/search SSE stream and renders the woven answer. Result pages
 * are noindex — the curated pages carry SEO.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import SearchExperience from "../components/cinematic/09-search-experience";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Answer — Ask Śrīla Prabhupāda",
  description:
    "His words, woven verbatim. Every passage labelled and cited, every citation linked to Vedabase.io.",
  robots: { index: false, follow: true },
};

export default async function SearchResults({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; only_his?: string }>;
}) {
  const { q, only_his } = await searchParams;
  const query = (q || "").trim();
  if (!query) redirect("/");
  // "Śrīla Prabhupāda's words only" — forwarded to the search API, where it
  // restricts recorded talks to paragraphs whose labelled speaker is his.
  return <SearchExperience q={query} onlyHis={only_his === "1"} />;
}
