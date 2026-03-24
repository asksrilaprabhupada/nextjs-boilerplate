import type { Metadata } from "next";
import Header from "../components/Header";
import StepsSection from "../components/StepsSection";
import FooterSection from "../components/FooterSection";

export const metadata: Metadata = {
  title: "How It Works — Ask Śrīla Prabhupāda",
  description: "Three simple steps: Ask a question, AI searches 27 books of Śrīla Prabhupāda, get a flowing answer with citations linked to Vedabase.io.",
};

export default function HowItWorksPage() {
  return (
    <>
      <Header />
      <main style={{ paddingTop: 92, display: "grid", gap: 36 }}>
        <StepsSection />
        <FooterSection />
      </main>
    </>
  );
}