/**
 * page.tsx — Features Page
 *
 * Showcases the platform's key features with header and footer.
 * Gives visitors a dedicated page to learn about the app's capabilities.
 */
import type { Metadata } from "next";
import Header from "../components/layout/01-header";
import FeaturesSection from "../components/landing/02-features-section";
import FooterSection from "../components/layout/02-footer";

export const metadata: Metadata = {
  title: "Features — Ask Śrīla Prabhupāda",
  description: "AI-powered search across 27 books of Śrīla Prabhupāda. 25,112 verses, 34,145 paragraphs, narrative answers, citation links to Vedabase.io.",
};

export default function FeaturesPage() {
  return (
    <>
      <Header />
      <main style={{ paddingTop: 92, display: "grid", gap: 36 }}>
        <FeaturesSection />
        <FooterSection />
      </main>
    </>
  );
}