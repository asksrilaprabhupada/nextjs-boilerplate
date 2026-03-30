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
  description: "AI-powered search across 36 books, 3,700 lectures, and 6,500 letters of Śrīla Prabhupāda. 244,000+ passages, narrative answers, citation links to Vedabase.io.",
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