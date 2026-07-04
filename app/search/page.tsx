/**
 * search/page.tsx — Search Results Page
 *
 * Server wrapper: SEO metadata around the cinematic woven-answer view — the
 * meditative loader, the question in big serif, verbatim passage cards with
 * Vedabase links, and the Dig-deeper drawer. The client component reads `?q=`
 * from the URL; wiring it to the live /api/search backend is the next
 * integration step (it currently renders the designed sample answer).
 */
import type { Metadata } from "next";
import SearchResultsPage from "../components/cinematic/08-search-results-page";

export const metadata: Metadata = {
  title: "Answer — Ask Śrīla Prabhupāda",
  description:
    "His words, woven verbatim. Every passage labelled and cited, every citation linked to Vedabase.io.",
};

export default function SearchResults() {
  return <SearchResultsPage />;
}
