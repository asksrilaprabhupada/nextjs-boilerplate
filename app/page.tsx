"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import LockScreen from "./components/LockScreen";
import Header from "./components/Header";
import HeroSearch from "./components/HeroSearch";
import NarrativeResponse, { SearchResults } from "./components/NarrativeResponse";
import WhyDifferent from "./components/WhyDifferent";
import TestimonialsSection from "./components/TestimonialsSection";
import CTASection from "./components/CTASection";
import FooterSection from "./components/FooterSection";
import PageOverlay from "./components/PageOverlay";
import AboutOverlay from "./components/AboutOverlay";
import DonateOverlay from "./components/DonateOverlay";
import ContactOverlay from "./components/ContactOverlay";
import FeatureRequestOverlay from "./components/FeatureRequestOverlay";
import FeedbackButton from "./components/FeedbackButton";

type OverlayItem = "About" | "Donate" | "Contact" | "Feature Request";

const overlayParamToItem: Record<string, OverlayItem> = { about: "About", donate: "Donate", contact: "Contact", feature: "Feature Request" };
const overlayItemToParam: Record<OverlayItem, string> = { About: "about", Donate: "donate", Contact: "contact", "Feature Request": "feature" };

export default function Home() {
  const [lockScreenVisible, setLockScreenVisible] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState<OverlayItem | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingNarrative, setStreamingNarrative] = useState("");
  const [currentQuery, setCurrentQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

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

  const handleClear = useCallback(() => {
    // Abort any ongoing stream
    if (abortRef.current) abortRef.current.abort();
    // Reset all search state → hero will reappear
    setSearchResults(null);
    setIsSearching(false);
    setIsStreaming(false);
    setStreamingNarrative("");
    setCurrentQuery("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleSearch = useCallback(async (query: string) => {
    // Abort any ongoing stream
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    setIsStreaming(false);
    setStreamingNarrative("");
    setSearchResults(null);
    setCurrentQuery(query);
    window.scrollTo({ top: 0, behavior: "smooth" });

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") || "";

      // Non-streaming response (cached results return as JSON)
      if (contentType.includes("application/json")) {
        setSearchResults(await res.json());
        setIsSearching(false);
        return;
      }

      // Streaming SSE response
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let narrativeAccum = "";
      let partialResults: SearchResults | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "metadata") {
              // Metadata arrived — render sidebar/layout immediately
              partialResults = {
                query: event.query,
                keywords: event.keywords || [],
                synonyms: event.synonyms || [],
                relatedConcepts: event.relatedConcepts || [],
                narrative: "",
                totalResults: event.totalResults,
                citations: event.citations,
                books: event.books,
              };
              setSearchResults(partialResults);
              setIsSearching(false);
              setIsStreaming(true);
            } else if (event.type === "narrative_chunk") {
              narrativeAccum += event.html;
              setStreamingNarrative(narrativeAccum);
            } else if (event.type === "done") {
              // Finalize: set the complete narrative into results
              if (partialResults) {
                setSearchResults({ ...partialResults, narrative: narrativeAccum });
              }
              setIsStreaming(false);
              setStreamingNarrative("");
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("Search failed:", err);
      }
    } finally {
      setIsSearching(false);
      setIsStreaming(false);
    }
  }, []);

  return (
    <>
      {lockScreenVisible && <LockScreen onDismiss={() => setLockScreenVisible(false)} />}
      <div style={{ opacity: lockScreenVisible ? 0 : 1, transition: "opacity 0.8s ease 0.4s", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <Header onMoreItemSelect={setOverlay} />
        <main style={{ flex: 1 }}>
          <div id="search">
            <HeroSearch
              onSearch={handleSearch}
              onClear={handleClear}
              isSearching={isSearching}
              hasResults={searchResults !== null}
              currentQuery={currentQuery}
            />
          </div>
          <NarrativeResponse results={searchResults} isLoading={isSearching} isStreaming={isStreaming} streamingNarrative={streamingNarrative} onSearch={handleSearch} />
          {!searchResults && !isSearching && (
            <>
              <WhyDifferent />
              <TestimonialsSection />
              <CTASection />
              <FooterSection />
            </>
          )}
        </main>

        <FeedbackButton currentQuery={currentQuery} />
      </div>

      {!lockScreenVisible && (
        <>
          <PageOverlay isOpen={overlayOpen === "About"} onClose={() => setOverlay(null)}><AboutOverlay /></PageOverlay>
          <PageOverlay isOpen={overlayOpen === "Donate"} onClose={() => setOverlay(null)}><DonateOverlay /></PageOverlay>
          <PageOverlay isOpen={overlayOpen === "Contact"} onClose={() => setOverlay(null)}><ContactOverlay /></PageOverlay>
          <PageOverlay isOpen={overlayOpen === "Feature Request"} onClose={() => setOverlay(null)}><FeatureRequestOverlay /></PageOverlay>
        </>
      )}
    </>
  );
}