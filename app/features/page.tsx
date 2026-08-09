/**
 * page.tsx — Features Page
 *
 * Server wrapper: SEO metadata around the cinematic features page — three
 * core features shown as live vignettes of the real interface, a quiet grid
 * of the supporting capabilities, a verse interlude, and a CTA back to
 * search. All motion and interaction live in the client component.
 */
import type { Metadata } from "next";
import FeaturesPage from "../components/cinematic/06-features-page";
import { getLockscreenPublicImageUrl } from "../lib/server/01-lockscreen-images";

const DEITIES_FILE = "Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg";

export const metadata: Metadata = {
  title: "Features — Ask Śrīla Prabhupāda",
  description:
    "Ask in your own words and search 36 books, 3,700 lectures, and 6,500 letters of Śrīla Prabhupāda. Verbatim answers, exact citations linked to Vedabase.io.",
  alternates: { canonical: "/features" },
};

export const dynamic = "force-static";

export default async function Features() {
  const deitiesImageUrl = await getLockscreenPublicImageUrl(DEITIES_FILE);
  return <FeaturesPage deitiesImageUrl={deitiesImageUrl} />;
}
