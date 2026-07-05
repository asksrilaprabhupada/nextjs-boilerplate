/**
 * 10-search-loader.tsx — Meditative Search Loader (SSE-driven)
 *
 * The full-screen aura + rotating-mandala loader shown while /api/search
 * streams. Unlike the old prototype timer, the label and percent are driven by
 * real pipeline `stage` events (understood → expanding → searching → reranking
 * → weaving); the bar eases toward each stage's target and snaps to 100 when
 * the result lands. While waiting, one short verbatim translation (with its
 * reference) rotates every 8 s. Under prefers-reduced-motion everything is
 * static: no mandala spin, no crossfade — just the label and the bar.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { SearchStageEvent } from "@/app/lib/types/01-search";

const MANDALA = Array.from({ length: 12 }, (_, i) => i * 30);

/**
 * Verbatim translations (with refs) rotated during the wait. Pulled exactly as
 * stored in the verses table (translation column) — never paraphrased.
 */
const WAIT_VERSES: { ref: string; text: string }[] = [
  { ref: "Bg. 2.20", text: "For the soul there is neither birth nor death at any time. He has not come into being, does not come into being, and will not come into being. He is unborn, eternal, ever-existing and primeval. He is not slain when the body is slain." },
  { ref: "Bg. 6.34", text: "The mind is restless, turbulent, obstinate and very strong, O Kṛṣṇa, and to subdue it, I think, is more difficult than controlling the wind." },
  { ref: "Bg. 6.35", text: "Lord Śrī Kṛṣṇa said: O mighty-armed son of Kuntī, it is undoubtedly very difficult to curb the restless mind, but it is possible by suitable practice and by detachment." },
  { ref: "Bg. 9.22", text: "But those who always worship Me with exclusive devotion, meditating on My transcendental form – to them I carry what they lack, and I preserve what they have." },
  { ref: "Bg. 18.66", text: "Abandon all varieties of religion and just surrender unto Me. I shall deliver you from all sinful reactions. Do not fear." },
];

/** Optimistic stage schedule used when SSE is unavailable (plain-fetch path). */
const FALLBACK_STAGES: SearchStageEvent[] = [
  { stage: "understood", pct: 12, label: "Reading your question…" },
  { stage: "searching", pct: 45, label: "Searching 244,148 passages…" },
  { stage: "reranking", pct: 70, label: "Selecting his words…" },
  { stage: "weaving", pct: 90, label: "Weaving the essay…" },
];
const FALLBACK_CAP = 92;

export default function SearchLoader({
  q,
  stage,
  done,
}: {
  q: string;
  /** Latest SSE stage event; null until the first arrives (or when SSE is unavailable). */
  stage: SearchStageEvent | null;
  /** True once the result has landed — the bar snaps to 100 and the loader fades. */
  done: boolean;
}) {
  const [pct, setPct] = useState(4);
  const [fallbackStage, setFallbackStage] = useState<SearchStageEvent | null>(null);
  const [verseIdx, setVerseIdx] = useState(0);
  const [reduced, setReduced] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch { /* older browsers */ }
  }, []);

  // No SSE events yet? Walk an optimistic timer over the same stages, capped
  // below 100 so the bar never lies about being finished.
  useEffect(() => {
    if (stage || done) return;
    let i = 0;
    setFallbackStage(FALLBACK_STAGES[0]);
    const iv = setInterval(() => {
      i += 1;
      if (i < FALLBACK_STAGES.length) setFallbackStage(FALLBACK_STAGES[i]);
      else clearInterval(iv);
    }, 4500);
    return () => clearInterval(iv);
  }, [stage, done]);

  const active = stage ?? fallbackStage;
  const target = done ? 100 : Math.min(active?.pct ?? 4, stage ? 100 : FALLBACK_CAP);

  // Ease the bar toward the current stage target (snap when motion is reduced).
  useEffect(() => {
    if (reduced) { setPct(target); return; }
    const step = () => {
      setPct((p) => {
        const next = p + Math.max(0.35, (target - p) * 0.06);
        return next >= target ? target : next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, reduced]);

  // Rotate one verse every 8 s (static under reduced motion).
  useEffect(() => {
    if (reduced) return;
    const iv = setInterval(() => setVerseIdx((i) => (i + 1) % WAIT_VERSES.length), 8000);
    return () => clearInterval(iv);
  }, [reduced]);

  const verse = WAIT_VERSES[verseIdx];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ position: "fixed", inset: 0, zIndex: 800, background: "rgba(250,247,241,0.97)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, opacity: done ? 0 : 1, transition: "opacity 0.7s ease", pointerEvents: done ? "none" : "auto" }}
    >
      <div style={{ position: "relative", width: "min(70vw, 300px)", height: "min(70vw, 300px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div aria-hidden style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "130%", height: "130%", borderRadius: "50%", background: "radial-gradient(circle, rgba(139,110,224,0.26) 0%, rgba(201,162,75,0.12) 42%, transparent 70%)", filter: "blur(38px)", animation: reduced ? "none" : "auraBreathe 4.5s ease-in-out infinite" }} />
        <svg viewBox="0 0 400 400" aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.16, animation: reduced ? "none" : "rotateMandala 60s linear infinite", color: "#6B57C9" }}>
          {MANDALA.map((deg, i) => (
            <g key={i} transform={`rotate(${deg} 200 200)`}><ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.6" /></g>
          ))}
          <circle cx="200" cy="200" r="70" fill="none" stroke="currentColor" strokeWidth="0.5" />
        </svg>
        <p className="font-display" style={{ fontSize: "clamp(17px, 2.4vw, 21px)", fontStyle: "italic", color: "#51409A", textAlign: "center", maxWidth: 240, position: "relative" }}>
          {active?.label ?? "Weaving his words…"}
        </p>
      </div>

      {/* The user's actual question — never a sample. */}
      <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 8, maxWidth: 460, textAlign: "center" }}>&ldquo;{q}&rdquo;</p>

      {/* Progress bar + percent */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, width: "min(80vw, 340px)" }}>
        <div aria-hidden style={{ flex: 1, height: 3, borderRadius: 100, background: "rgba(107,87,201,0.12)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", borderRadius: 100, background: "linear-gradient(90deg, #6B57C9, #C9A24B)", transition: reduced ? "none" : "width 0.2s linear" }} />
        </div>
        <span className="font-body" style={{ fontSize: 11.5, fontWeight: 600, color: "#9A8F7D", minWidth: 34, textAlign: "right" }}>{Math.round(pct)}%</span>
      </div>

      {/* One rotating verbatim verse while the library answers */}
      <figure key={reduced ? "static" : verseIdx} style={{ margin: "26px 0 0", maxWidth: 520, textAlign: "center", opacity: 0.92, animation: reduced ? "none" : "cineWaitVerse 8s ease both" }}>
        <blockquote className="font-display" style={{ margin: 0, fontSize: "clamp(14px,1.7vw,16.5px)", fontStyle: "italic", lineHeight: 1.6, color: "#6B6151" }}>
          &ldquo;{verse.text}&rdquo;
        </blockquote>
        <figcaption className="font-body" style={{ marginTop: 6, fontSize: 11.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9A8F7D" }}>
          {verse.ref} · translation by Śrīla Prabhupāda
        </figcaption>
      </figure>

      <style jsx global>{`
        @keyframes cineWaitVerse {
          0% { opacity: 0; transform: translateY(6px); }
          6% { opacity: 0.92; transform: translateY(0); }
          94% { opacity: 0.92; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
