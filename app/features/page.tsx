import type { Metadata } from "next";
import Header from "../components/Header";
import FeaturesSection from "../components/FeaturesSection";
import FooterSection from "../components/FooterSection";

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