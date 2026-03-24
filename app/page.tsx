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

const overlayParamToItem: Record<string, OverlayItem> = { about: "About", donate: "Donate", contact: "Contact" };
const overlayItemToParam: Record<OverlayItem, string> = { About: "about", Donate: "donate", Contact: "contact" };

export default function Home() {
  const [lockScreenVisible, setLockScreenVisible] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState<OverlayItem | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [currentQuery, setCurrentQuery] = useState("");

  useEffect(() => {
    if (lockScreenVisible) return;
    const sync = () => {
      const overlay = new URLSearchParams(window.location.search).get("overlay");
      setOverlayOpen(overlay ? overlayParamToItem[overlay] ?? null : null);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [lockScreenVisible]);

  const setOverlay = useCallback((overlay: OverlayItem | null) => {
    setOverlayOpen(overlay);
    const url = new URL(window.location.href);
    if (overlay) url.searchParams.set("overlay", overlayItemToParam[overlay]);
    else url.searchParams.delete("overlay");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const handleSearch = useCallback(async (query: string) => {
    setIsSearching(true);
    setSearchResults(null);
    setCurrentQuery(query);
    window.scrollTo({ top: 0, behavior: "smooth" });

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
      <div style={{ opacity: lockScreenVisible ? 0 : 1, transition: "opacity 0.8s ease 0.4s", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <Header onMoreItemSelect={setOverlay} />
        <main style={{ flex: 1 }}>
          <div id="search">
            <HeroSearch onSearch={handleSearch} isSearching={isSearching} hasResults={searchResults !== null} currentQuery={currentQuery} />
          </div>
          <NarrativeResponse results={searchResults} isLoading={isSearching} onSearch={handleSearch} />
          {!searchResults && !isSearching && (
            <>
              <StatsSection />
              <TestimonialsSection />
              <CTASection />
              <FooterSection />
            </>
          )}
        </main>
      </div>
      {!lockScreenVisible && (
        <>
          <PageOverlay isOpen={overlayOpen === "About"} onClose={() => setOverlay(null)}><AboutOverlay /></PageOverlay>
          <PageOverlay isOpen={overlayOpen === "Donate"} onClose={() => setOverlay(null)}><DonateOverlay /></PageOverlay>
          <PageOverlay isOpen={overlayOpen === "Contact"} onClose={() => setOverlay(null)}><ContactOverlay /></PageOverlay>
        </>
      )}
    </>
  );
}