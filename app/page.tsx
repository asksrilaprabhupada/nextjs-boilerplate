"use client";

import { useState, useCallback } from "react";
import LockScreen from "./components/LockScreen";
import Header from "./components/Header";
import HeroSearch from "./components/HeroSearch";
import NarrativeResponse, { SearchResults } from "./components/NarrativeResponse";
import PageOverlay from "./components/PageOverlay";
import AboutOverlay from "./components/AboutOverlay";
import DonateOverlay from "./components/DonateOverlay";
import ContactOverlay from "./components/ContactOverlay";

export default function Home() {
  const [lockScreenVisible, setLockScreenVisible] = useState(true);
  const [activeNav, setActiveNav] = useState("Search");
  const [overlayOpen, setOverlayOpen] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const handleNavChange = useCallback((nav: string) => {
    if (nav === "About" || nav === "Donate" || nav === "Contact") {
      setOverlayOpen(nav);
    } else {
      setActiveNav(nav);
      setOverlayOpen(null);
    }
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
      {/* Lock Screen */}
      {lockScreenVisible && (
        <LockScreen onDismiss={() => setLockScreenVisible(false)} />
      )}

      {/* Main App */}
      <div
        style={{
          opacity: lockScreenVisible ? 0 : 1,
          transition: "opacity 0.8s ease 0.4s",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Header activeNav={activeNav} onNavChange={handleNavChange} />

        <main style={{ flex: 1 }}>
          <HeroSearch
            onSearch={handleSearch}
            isSearching={isSearching}
            hasResults={searchResults !== null}
          />

          <NarrativeResponse
            results={searchResults}
            isLoading={isSearching}
          />
        </main>
      </div>

      {/* Modal Overlays */}
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
