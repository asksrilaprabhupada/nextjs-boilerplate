/**
 * 05-search-progress.tsx — Meditative search-in-progress
 *
 * The wait should feel like settling, not loading. A soft lavender aura breathes
 * slowly beneath one quiet line ("Gathering the teachings…"), the source names
 * cycle by in low-contrast text, and skeleton passage cards shimmer where the
 * answer will appear — so the results area is already "there" as it fills in.
 * One accent (violet), slow and soft; reduced-motion safe (transform/opacity only).
 */
"use client";

import { useState, useEffect } from "react";

const SOURCES = [
  "Bhagavad-gītā",
  "Śrīmad-Bhāgavatam",
  "Caitanya-caritāmṛta",
  "his recorded lectures",
  "his letters",
];

interface SearchProgressProps {
  isSearching: boolean;
}

export default function SearchProgress({ isSearching }: SearchProgressProps) {
  const [src, setSrc] = useState(0);

  useEffect(() => {
    if (!isSearching) { setSrc(0); return; }
    const id = setInterval(() => setSrc((s) => (s + 1) % SOURCES.length), 1900);
    return () => clearInterval(id);
  }, [isSearching]);

  if (!isSearching) return null;

  return (
    <div className="search-progress" style={{ contain: "layout style paint" }}>
      {/* A soft lavender aura, breathing slowly — calm, not a spinner. */}
      <div className="aura" aria-hidden="true" />

      <p className="gather-line font-body" aria-live="polite">Gathering the teachings…</p>
      <p key={src} className="source-line font-body" aria-hidden="true">{SOURCES[src]}</p>

      {/* Skeleton passage cards where the answer will compose in. */}
      <div className="skeletons" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className="skeleton-card" key={i}>
            <div className="sk-line sk-serif" />
            <div className="sk-line" style={{ width: "94%" }} />
            <div className="sk-line" style={{ width: "80%" }} />
            <div className="sk-chip" />
          </div>
        ))}
      </div>

      <style jsx>{`
        .search-progress {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 100%;
          max-width: 720px;
          margin: 0 auto;
          padding: 56px clamp(16px, 4vw, 24px) 44px;
          gap: 14px;
        }
        .aura {
          width: 118px;
          height: 118px;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 50%,
            color-mix(in srgb, var(--p-lavender) 55%, transparent) 0%,
            color-mix(in srgb, var(--accent) 26%, transparent) 45%,
            transparent 72%);
          filter: blur(6px);
          animation: auraBreath 3s var(--ease-standard) infinite;
        }
        @keyframes auraBreath {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50%      { transform: scale(1.04); opacity: 1; }
        }
        .gather-line {
          font-size: 1rem;
          color: var(--ink-muted);
          letter-spacing: 0.01em;
          margin: 6px 0 0;
          text-align: center;
        }
        .source-line {
          font-size: 0.85rem;
          color: var(--ink-subtle);
          margin: 0;
          text-align: center;
          animation: sourceIn 0.6s var(--ease-decelerate) both;
        }
        @keyframes sourceIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .skeletons {
          width: 100%;
          margin-top: 26px;
          display: flex;
          flex-direction: column;
        }
        .skeleton-card {
          padding: var(--space-6) 0;
          border-bottom: 1px solid var(--border-hair);
        }
        .skeleton-card:last-child { border-bottom: none; }
        .sk-line {
          position: relative;
          overflow: hidden;
          height: 13px;
          border-radius: 6px;
          background: var(--surface-sunken);
          margin-bottom: 11px;
        }
        .sk-serif { height: 20px; margin-bottom: 16px; }
        .sk-line::after {
          content: "";
          position: absolute;
          inset: 0;
          transform: translateX(-100%);
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 10%, transparent), transparent);
          animation: skShimmer 1.6s var(--ease-standard) infinite;
        }
        .sk-chip {
          width: 92px;
          height: 20px;
          border-radius: var(--radius-full);
          background: var(--accent-tint);
          margin-top: 4px;
        }
        @keyframes skShimmer {
          to { transform: translateX(100%); }
        }
        @media (max-width: 480px) {
          .aura { width: 96px; height: 96px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .aura { animation: none; opacity: 0.85; }
          .source-line { animation: none; }
          .sk-line::after { animation: none; }
        }
      `}</style>
    </div>
  );
}
