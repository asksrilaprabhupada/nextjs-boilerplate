import Header from "../components/Header";
import FeaturesSection from "../components/FeaturesSection";
import FooterSection from "../components/FooterSection";

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
