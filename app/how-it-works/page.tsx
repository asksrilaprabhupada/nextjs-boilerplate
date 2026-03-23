import Header from "../components/Header";
import StepsSection from "../components/StepsSection";
import FooterSection from "../components/FooterSection";

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
