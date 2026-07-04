/**
 * page.tsx — How It Works Page
 *
 * Server wrapper: SEO metadata around the cinematic explainer — three numbered
 * steps (Ask → Verify → Go deeper), the under-the-hood pipeline, and a
 * full-bleed CTA. All motion and interaction live in the client component.
 */
import type { Metadata } from "next";
import HowItWorksPage from "../components/cinematic/07-how-it-works-page";

export const metadata: Metadata = {
  title: "How It Works — Ask Śrīla Prabhupāda",
  description:
    "Three steps to his answer: ask in plain language, read his exact words, verify every source. Every citation links directly to Vedabase.io.",
};

export default function HowItWorks() {
  return <HowItWorksPage />;
}
