/**
 * page.tsx — Home Page
 *
 * Main entry point of the app that orchestrates the lock screen, search bar, narrative results, landing sections, and modal overlays.
 * Ties together all major features into a single-page search experience.
 */
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import LockScreen from "./components/lockscreen/01-lock-screen";
import Header from "./components/layout/01-header";
import HeroSearch from "./components/search/01-hero-search";
import NarrativeResponse, { SearchResults } from "./components/results/01-narrative-response";
import WhyDifferent from "./components/landing/01-why-different";
import TestimonialsSection from "./components/landing/04-testimonials-section";
import CTASection from "./components/landing/05-cta-section";
import FooterSection from "./components/layout/02-footer";
import PageOverlay from "./components/overlays/01-page-overlay";
import AboutOverlay from "./components/overlays/02-about-overlay";
import DonateOverlay from "./components/overlays/03-donate-overlay";
import ContactOverlay from "./components/overlays/04-contact-overlay";
import FeatureRequestOverlay from "./components/overlays/05-feature-request-overlay";
import FeedbackButton from "./components/feedback/01-feedback-button";
import { logSearch, logBehavior } from "./lib/02-analytics";
import { useSearchBehaviorTracker } from "./hooks/01-use-search-behavior-tracker";

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
  const [searchLogId, setSearchLogId] = useState<string | null>(null);
  const searchLogIdRef = useRef<string | null>(null);
  const searchStartTimeRef = useRef<number>(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  useSearchBehaviorTracker(searchLogId);

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

  const scrollToProgress = useCallback(() => {
    setTimeout(() => {
      progressRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  }, []);

  const scrollToResults = useCallback(() => {
    setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
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

    // Log follow-up if there was a previous search
    if (searchLogIdRef.current) {
      logBehavior({ searchLogId: searchLogIdRef.current, followedUpQuery: query });
    }

    searchStartTimeRef.current = Date.now();
    setIsSearching(true);
    setIsStreaming(false);
    setStreamingNarrative("");
    setSearchResults(null);
    setSearchLogId(null);
    searchLogIdRef.current = null;
    setCurrentQuery(query);

    // Scroll to progress indicator
    scrollToProgress();

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") || "";

      // Non-streaming response (cached results return as JSON)
      if (contentType.includes("application/json")) {
        const jsonResults = await res.json();
        setSearchResults(jsonResults);
        setIsSearching(false);

        // Scroll to results
        scrollToResults();

        // Log the search asynchronously (fire and forget)
        logSearch({
          query,
          totalResults: jsonResults.totalResults || 0,
          verseIds: (jsonResults.books || []).flatMap((b: any) => (b.verses || []).map((v: any) => v.id)),
          proseIds: (jsonResults.books || []).flatMap((b: any) => (b.prose || []).map((p: any) => p.id)),
          booksReturned: (jsonResults.books || []).map((b: any) => b.slug),
          searchMethod: "hybrid",
          totalDurationMs: Date.now() - searchStartTimeRef.current,
          narrativeLength: (jsonResults.narrative || "").length,
        }).then(id => { searchLogIdRef.current = id; setSearchLogId(id); });

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

              // Scroll to results when metadata arrives
              scrollToResults();
            } else if (event.type === "narrative_chunk") {
              narrativeAccum += event.html;
              setStreamingNarrative(narrativeAccum);
            } else if (event.type === "done") {
              // Finalize: set the complete narrative into results
              if (partialResults) {
                const finalResults = { ...partialResults, narrative: narrativeAccum };
                setSearchResults(finalResults);

                // Log the search asynchronously (fire and forget)
                logSearch({
                  query,
                  totalResults: finalResults.totalResults || 0,
                  verseIds: (finalResults.books || []).flatMap((b: any) => (b.verses || []).map((v: any) => v.id)),
                  proseIds: (finalResults.books || []).flatMap((b: any) => (b.prose || []).map((p: any) => p.id)),
                  booksReturned: (finalResults.books || []).map((b: any) => b.slug),
                  searchMethod: "hybrid",
                  totalDurationMs: Date.now() - searchStartTimeRef.current,
                  narrativeLength: narrativeAccum.length,
                }).then(id => { searchLogIdRef.current = id; setSearchLogId(id); });
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
  }, [scrollToProgress, scrollToResults]);

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
              progressRef={progressRef}
            />
          </div>
          <div ref={resultsRef}>
            <NarrativeResponse results={searchResults} isLoading={isSearching} isStreaming={isStreaming} streamingNarrative={streamingNarrative} onSearch={handleSearch} searchLogId={searchLogId} />
          </div>
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
