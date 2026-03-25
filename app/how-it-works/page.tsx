/**
 * page.tsx — How It Works Page
 *
 * Explains the three-step search process with header and footer.
 * Guides new users through how to use Ask Srila Prabhupada.
 */
import type { Metadata } from "next";
import Header from "../components/layout/01-header";
import StepsSection from "../components/landing/03-steps-section";
import FooterSection from "../components/layout/02-footer";

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