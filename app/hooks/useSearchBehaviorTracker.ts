"use client";

import { useEffect, useRef, useCallback } from "react";
import { logBehavior } from "../lib/analytics";

/**
 * Tracks user behavior for a search result:
 * - Time spent viewing the result
 * - Whether they scrolled to the bottom of the narrative
 * - Which citation links they clicked
 * - Which "Want More" books they opened
 *
 * Sends a beacon on unmount or when searchLogId changes.
 */
export function useSearchBehaviorTracker(searchLogId: string | null) {
  const startTime = useRef<number>(Date.now());
  const clickedCitations = useRef<Set<string>>(new Set());
  const clickedWantMore = useRef<Set<string>>(new Set());
  const scrolledToBottom = useRef(false);
  const sentRef = useRef(false);

  // Reset on new search
  useEffect(() => {
    startTime.current = Date.now();
    clickedCitations.current = new Set();
    clickedWantMore.current = new Set();
    scrolledToBottom.current = false;
    sentRef.current = false;
  }, [searchLogId]);

  // Track scroll depth
  useEffect(() => {
    if (!searchLogId) return;

    const handleScroll = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = document.documentElement.clientHeight;

      // Consider "bottom" as within 200px of the end
      if (scrollTop + clientHeight >= scrollHeight - 200) {
        scrolledToBottom.current = true;
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [searchLogId]);

  // Track citation link clicks via event delegation
  useEffect(() => {
    if (!searchLogId) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Citation link click
      const verseLink = target.closest(".verse-link");
      if (verseLink) {
        const ref = verseLink.querySelector(".verse-ref")?.textContent?.trim();
        if (ref) clickedCitations.current.add(ref);
      }

      // Want More click
      const wantMore = target.closest(".want-more-trigger");
      if (wantMore) {
        const book = wantMore.getAttribute("data-book");
        if (book) clickedWantMore.current.add(book);
      }
    };

    document.addEventListener("click", handleClick, { passive: true });
    return () => document.removeEventListener("click", handleClick);
  }, [searchLogId]);

  // Send behavior data
  const sendBehavior = useCallback(() => {
    if (!searchLogId || sentRef.current) return;
    sentRef.current = true;

    const timeOnResultMs = Date.now() - startTime.current;

    // Only send if they spent at least 2 seconds (filter out bounces)
    if (timeOnResultMs < 2000) return;

    logBehavior({
      searchLogId,
      clickedCitations: [...clickedCitations.current],
      clickedWantMore: [...clickedWantMore.current],
      scrolledToBottom: scrolledToBottom.current,
      timeOnResultMs,
    });
  }, [searchLogId]);

  // Send on unmount or when searchLogId changes (new search)
  useEffect(() => {
    return () => {
      sendBehavior();
    };
  }, [sendBehavior]);

  // Also send on page visibility change (tab switch, close)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        sendBehavior();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [sendBehavior]);

  // Expose manual trigger for "Want More" clicks from modals
  const trackWantMore = useCallback((bookSlug: string) => {
    clickedWantMore.current.add(bookSlug);
  }, []);

  return { trackWantMore };
}