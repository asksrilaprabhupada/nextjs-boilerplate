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

  const dismiss = (e: React.MouseEvent) => { e.stopPropagation(); handleDismiss(); };

  return (
    <div role="button" tabIndex={0} aria-label="Enter the site" onClick={handleDismiss}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "var(--surface)", cursor: "pointer",
        transform: visible ? "translateY(0)" : "translateY(-100%)", opacity: visible ? 1 : 0,
        transition: "transform 0.9s var(--ease-standard), opacity 0.6s ease", overflow: "hidden" }}>

      {/* Faint backdrop: any admin-uploaded photos remain, gently, under a warm wash. */}
      {lockscreenVideo ? (
        <video autoPlay muted loop playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.24 }}>
          <source src={lockscreenVideo} type="video/mp4" />
        </video>
      ) : (
        <div style={{ position: "absolute", inset: 0, opacity: 0.22 }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${currentImage.url})`, backgroundSize: "cover", backgroundPosition: "center", animation: `${kenBurns(currentImage.kenBurnsDirection)} 12s ease-in-out infinite alternate`, opacity: transitioning ? 0 : 1, transition: `opacity ${TRANSITION_MS}ms ease` }} />
          <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${nextImage.url})`, backgroundSize: "cover", backgroundPosition: "center", animation: `${kenBurns(nextImage.kenBurnsDirection)} 12s ease-in-out infinite alternate`, opacity: transitioning ? 1 : 0, transition: `opacity ${TRANSITION_MS}ms ease` }} />
        </div>
      )}

      {/* Warm near-white wash */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, color-mix(in srgb, var(--surface) 80%, transparent), color-mix(in srgb, var(--surface) 92%, transparent))" }} />

      {/* Soft aura blooming */}
      <div aria-hidden="true" style={{ position: "absolute", top: "42%", left: "50%", width: "min(92vw,640px)", height: "min(92vw,640px)", borderRadius: "50%", background: "radial-gradient(circle, color-mix(in srgb, var(--p-lavender) 20%, transparent) 0%, color-mix(in srgb, var(--accent) 7%, transparent) 46%, transparent 72%)", filter: "blur(24px)", pointerEvents: "none", opacity: entered ? 1 : 0, transform: entered ? "translate(-50%,-50%) scale(1)" : "translate(-50%,-50%) scale(0.86)", transition: "opacity 1.6s ease, transform 1.6s cubic-bezier(0,0,0.2,1)" }} />

      {/* Faint, very-low-opacity mandala */}
      <svg viewBox="0 0 400 400" style={{ position: "absolute", top: "42%", left: "50%", width: "min(78vw,560px)", height: "min(78vw,560px)", opacity: 0.05, animation: "rotate-mandala 140s linear infinite", pointerEvents: "none", color: "var(--accent)", transform: "translate(-50%,-50%)" }}>
        {[...Array(12)].map((_, i) => (<g key={i} transform={`rotate(${i*30} 200 200)`}><ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.5" /><ellipse cx="200" cy="100" rx="10" ry="24" fill="none" stroke="currentColor" strokeWidth="0.3" /></g>))}
        <circle cx="200" cy="200" r="60" fill="none" stroke="currentColor" strokeWidth="0.4" />
        <circle cx="200" cy="200" r="90" fill="none" stroke="currentColor" strokeWidth="0.3" />
        <circle cx="200" cy="200" r="130" fill="none" stroke="currentColor" strokeWidth="0.2" />
      </svg>

      {/* Obvious skip (top-right) */}
      <button onClick={dismiss} className="font-body" aria-label="Skip intro"
        style={{ position: "absolute", top: 16, right: 18, zIndex: 3, background: "none", border: "none", color: "var(--ink-subtle)", fontSize: 13, fontWeight: 500, letterSpacing: "0.04em", cursor: "pointer" }}>
        Skip
      </button>

      {/* Centered: title fades up, then the verse cross-fades in beneath. */}
      <div style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", textAlign: "center" }}>
        <h1 className="font-display" style={{ fontSize: "clamp(2rem,6vw,3.4rem)", fontWeight: 600, color: "var(--ink-strong)", letterSpacing: "-0.02em", margin: 0, opacity: entered ? 1 : 0, transform: entered ? "translateY(0)" : "translateY(14px)", transition: "opacity 0.5s cubic-bezier(0,0,0.2,1), transform 0.5s cubic-bezier(0,0,0.2,1)" }}>
          Ask Śrīla Prabhupāda
        </h1>
        <p className="font-display" style={{ maxWidth: 520, marginTop: 24, fontSize: "clamp(0.95rem,2vw,1.2rem)", fontStyle: "italic", color: "var(--ink-muted)", lineHeight: 1.7, opacity: entered ? 1 : 0, transform: entered ? "translateY(0)" : "translateY(10px)", transition: "opacity 0.7s ease 0.35s, transform 0.7s cubic-bezier(0,0,0.2,1) 0.35s" }}>
          &ldquo;{verse.text}&rdquo;
        </p>
        <span className="font-body" style={{ marginTop: 12, fontSize: 13, fontWeight: 500, color: "var(--accent-strong)", letterSpacing: "0.04em", opacity: entered ? 1 : 0, transition: "opacity 0.7s ease 0.5s" }}>— {verse.citation}</span>
        <div style={{ marginTop: 40, opacity: entered ? 1 : 0, transform: entered ? "translateY(0)" : "translateY(8px)", transition: "opacity 0.7s ease 0.65s, transform 0.7s cubic-bezier(0,0,0.2,1) 0.65s" }}>
          <button onClick={dismiss} className="btn-primary" aria-label="Enter"><span>Enter ↵</span></button>
        </div>
      </div>
    </div>
  );
}