"use client";

import { useState, useCallback, useEffect } from "react";
import LockScreen from "./components/LockScreen";
import Header from "./components/Header";
import HeroSearch from "./components/HeroSearch";
import NarrativeResponse, { SearchResults } from "./components/NarrativeResponse";
import StatsSection from "./components/StatsSection";
import TestimonialsSection from "./components/TestimonialsSection";
import CTASection from "./components/CTASection";
import FooterSection from "./components/FooterSection";
import PageOverlay from "./components/PageOverlay";
import AboutOverlay from "./components/AboutOverlay";
import DonateOverlay from "./components/DonateOverlay";
import ContactOverlay from "./components/ContactOverlay";

type OverlayItem = "About" | "Donate" | "Contact";

export default function Home() {
  const [lockScreenVisible, setLockScreenVisible] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState<OverlayItem | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const overlay = new URLSearchParams(window.location.search).get("overlay");
    if (overlay === "about" || overlay === "donate" || overlay === "contact") {
      const normalized = (overlay[0].toUpperCase() + overlay.slice(1)) as OverlayItem;
      setOverlayOpen(normalized);
      return;
    }

    setOverlayOpen(null);
  }, []);

  const handleSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    setSearchResults(null);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      }
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
    }
  }, []);

  return (
    <>
      {lockScreenVisible && <LockScreen onDismiss={() => setLockScreenVisible(false)} />}

      <div
        style={{
          opacity: lockScreenVisible ? 0 : 1,
          transition: "opacity 0.8s ease 0.4s",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Header onMoreItemSelect={setOverlayOpen} />

        <main style={{ flex: 1 }}>
          <div id="search">
            <HeroSearch
              onSearch={handleSearch}
              isSearching={isSearching}
              hasResults={searchResults !== null}
            />
          </div>

          <NarrativeResponse results={searchResults} isLoading={isSearching} />

          {!searchResults && (
            <>
              <StatsSection />
              <TestimonialsSection />
              <CTASection />
              <FooterSection />
            </>
          )}
        </main>
      </div>

      <PageOverlay
        isOpen={overlayOpen === "About"}
        onClose={() => setOverlayOpen(null)}
      >
        <AboutOverlay />
      </PageOverlay>

      <PageOverlay
        isOpen={overlayOpen === "Donate"}
        onClose={() => setOverlayOpen(null)}
      >
        <DonateOverlay />
      </PageOverlay>

      <PageOverlay
        isOpen={overlayOpen === "Contact"}
        onClose={() => setOverlayOpen(null)}
      >
        <ContactOverlay />
      </PageOverlay>
    </>
  );
}
