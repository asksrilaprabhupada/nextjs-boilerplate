/**
 * page.tsx — Features Page
 *
 * Server wrapper: SEO metadata around the cinematic features page — masked
 * title reveal, six numbered feature rows, verse interlude, and CTA back to
 * search. All motion and interaction live in the client component.
 */
import type { Metadata } from "next";
import FeaturesPage from "../components/cinematic/06-features-page";

export const metadata: Metadata = {
  title: "Features — Ask Śrīla Prabhupāda",
  description:
    "Ask in your own words and search 36 books, 3,700 lectures, and 6,500 letters of Śrīla Prabhupāda. Verbatim answers, exact citations linked to Vedabase.io.",
};

export default function Features() {
  return <FeaturesPage />;
}
