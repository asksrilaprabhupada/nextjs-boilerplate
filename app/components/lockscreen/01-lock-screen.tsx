/**
 * 01-lock-screen.tsx — Lock Screen
 *
 * Full-screen intro modal with an image slideshow of Srila Prabhupada, Ken Burns animations, daily verse rotation, and optional video background.
 * Creates a devotional first impression when users visit the site.
 */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { dailyVerses, lockscreenFallbackImage, lockscreenVideo, type SlideImage } from "../../lib/06-lockscreen-data";

const FULL_VIEW_MS = 4000;
const TRANSITION_MS = 1200;

function shuffleIndices(length: number): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

// Check if lock screen was already dismissed this session
function wasAlreadyDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try { return sessionStorage.getItem("lockscreen_dismissed") === "1"; } catch { return false; }
}

function markDismissed() {
  try { sessionStorage.setItem("lockscreen_dismissed", "1"); } catch { /* ok */ }
}

export default function LockScreen({ onDismiss }: { onDismiss: () => void }) {
  const [shouldShow, setShouldShow] = useState(false);
  const [slideshowImages, setSlideshowImages] = useState<SlideImage[]>([lockscreenFallbackImage]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [nextImageIndex, setNextImageIndex] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [verse] = useState(() => dailyVerses[Math.floor(Math.random() * dailyVerses.length)]);
  const [visible, setVisible] = useState(true);
  const [entered, setEntered] = useState(false);
  const deckRef = useRef<number[]>([]);
  const deckPointerRef = useRef(0);
  const activeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: check if already dismissed
  useEffect(() => {
    if (wasAlreadyDismissed()) {
      onDismiss();
    } else {
      setShouldShow(true);
    }
  }, [onDismiss]);

  useEffect(() => {
    if (!shouldShow) return;
    let active = true;
    async function loadLockscreenImages() {
      try {
        const response = await fetch("/api/lockscreen-images");
        if (!response.ok) return;
        const data: { images?: SlideImage[] } = await response.json();
        if (!active || !data.images || data.images.length === 0) return;
        setSlideshowImages(data.images);
      } catch { /* keep fallback */ }
    }
    void loadLockscreenImages();
    return () => { active = false; };
  }, [shouldShow]);

  useEffect(() => {
    if (!shouldShow) return;
    if (activeTimerRef.current) { clearTimeout(activeTimerRef.current); activeTimerRef.current = null; }
    setTransitioning(false);
    if (lockscreenVideo || slideshowImages.length <= 1) { setCurrentImageIndex(0); setNextImageIndex(0); return; }

    const refillDeck = (lastIdx: number) => {
      const shuffled = shuffleIndices(slideshowImages.length);
      if (shuffled.length > 1 && lastIdx >= 0 && shuffled[0] === lastIdx) {
        const swap = shuffled.findIndex(i => i !== lastIdx);
        if (swap > 0) [shuffled[0], shuffled[swap]] = [shuffled[swap], shuffled[0]];
      }
      deckRef.current = shuffled; deckPointerRef.current = 0;
    };
    const drawNext = (lastIdx: number) => {
      if (deckPointerRef.current >= deckRef.current.length) refillDeck(lastIdx);
      return deckRef.current[deckPointerRef.current++];
    };

    refillDeck(-1);
    const initCurrent = drawNext(-1);
    const initNext = drawNext(initCurrent);
    setCurrentImageIndex(initCurrent); setNextImageIndex(initNext);
    let cancelled = false;
    const runCycle = (currentIdx: number) => {
      activeTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        const upcoming = drawNext(currentIdx);
        setNextImageIndex(upcoming); setTransitioning(true);
        activeTimerRef.current = setTimeout(() => {
          if (cancelled) return;
          setCurrentImageIndex(upcoming); setTransitioning(false); runCycle(upcoming);
        }, TRANSITION_MS);
      }, FULL_VIEW_MS);
    };
    runCycle(initCurrent);
    return () => { cancelled = true; if (activeTimerRef.current) clearTimeout(activeTimerRef.current); };
  }, [slideshowImages, shouldShow]);

  useEffect(() => {
    if (!shouldShow) return;
    const timer = setTimeout(() => setEntered(true), 100);
    return () => clearTimeout(timer);
  }, [shouldShow]);

  const handleDismiss = useCallback(() => {
    markDismissed();
    setVisible(false);
    setTimeout(onDismiss, 900);
  }, [onDismiss]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleDismiss(); }
  }, [handleDismiss]);

  useEffect(() => {
    if (!shouldShow) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown, shouldShow]);

  if (!shouldShow) return null;

  const currentImage = slideshowImages[currentImageIndex] ?? lockscreenFallbackImage;
  const nextImage = slideshowImages[nextImageIndex] ?? currentImage;
  const kenBurns = (dir: string) => dir === "pan-left" ? "kenBurnsPanLeft" : dir === "pan-right" ? "kenBurnsPanRight" : "kenBurnsZoomIn";

  return (
    <div role="button" tabIndex={0} aria-label="Click to enter" onClick={handleDismiss}
      style={{ position: "fixed", inset: 0, zIndex: 1000, backgroundColor: "#0B1021", cursor: "pointer",
        transform: visible ? "translateY(0)" : "translateY(-100%)", opacity: visible ? 1 : 0,
        transition: "transform 0.9s cubic-bezier(0.16,1,0.3,1), opacity 0.6s ease", overflow: "hidden" }}>
      {lockscreenVideo ? (
        <video autoPlay muted loop playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}>
          <source src={lockscreenVideo} type="video/mp4" />
        </video>
      ) : (
        <>
          <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${currentImage.url})`, backgroundSize: "cover", backgroundPosition: "center", animation: `${kenBurns(currentImage.kenBurnsDirection)} 10s ease-in-out infinite alternate`, opacity: transitioning ? 0 : 1, transition: `opacity ${TRANSITION_MS}ms ease` }} />
          <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${nextImage.url})`, backgroundSize: "cover", backgroundPosition: "center", animation: `${kenBurns(nextImage.kenBurnsDirection)} 10s ease-in-out infinite alternate`, opacity: transitioning ? 1 : 0, transition: `opacity ${TRANSITION_MS}ms ease` }} />
        </>
      )}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(30,27,75,0.85) 0%, rgba(30,27,75,0.5) 30%, rgba(139,92,246,0.15) 55%, rgba(196,181,253,0.10) 100%)" }} />
      <svg viewBox="0 0 400 400" style={{ position: "absolute", top: "50%", left: "50%", width: "min(75vw,550px)", height: "min(75vw,550px)", opacity: 0.06, animation: "rotate-mandala 120s linear infinite", pointerEvents: "none", color: "#C4B5FD", transform: "translate(-50%,-50%)" }}>
        {[...Array(12)].map((_, i) => (<g key={i} transform={`rotate(${i*30} 200 200)`}><ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.5" /><ellipse cx="200" cy="100" rx="10" ry="24" fill="none" stroke="currentColor" strokeWidth="0.3" /></g>))}
        <circle cx="200" cy="200" r="60" fill="none" stroke="currentColor" strokeWidth="0.4" />
        <circle cx="200" cy="200" r="90" fill="none" stroke="currentColor" strokeWidth="0.3" />
        <circle cx="200" cy="200" r="130" fill="none" stroke="currentColor" strokeWidth="0.2" />
      </svg>
      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", paddingBottom: "clamp(60px,12vh,120px)", opacity: entered ? 1 : 0, transform: entered ? "translateY(0)" : "translateY(24px)", transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
        <div className="font-display" style={{ fontSize: "clamp(0.95rem,2vw,1.28rem)", fontWeight: 400, fontStyle: "italic", color: "rgba(255,255,255,0.8)", maxWidth: 500, textAlign: "center", lineHeight: 1.75, padding: "0 24px" }}>
          &ldquo;{verse.text}&rdquo;
        </div>
        <div className="font-body" style={{ fontSize: "clamp(11px, 2vw, 13px)", fontWeight: 500, color: "rgba(196,181,253,0.8)", marginTop: 14, letterSpacing: "0.04em" }}>— {verse.citation}</div>
        <div style={{ marginTop: 44, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", animation: "pulse-arrow 3s ease-in-out infinite" }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ transform: "rotate(180deg)" }}><path d="M8 12V4M4 8l4-4 4 4" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <span className="font-body" style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.14em", color: "rgba(255,255,255,0.3)" }}>Click anywhere to enter</span>
        </div>
      </div>
    </div>
  );
}