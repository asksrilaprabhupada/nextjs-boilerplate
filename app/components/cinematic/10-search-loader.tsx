/**
 * 10-search-loader.tsx — The Searching screen (cinematic redesign)
 *
 * Designs: docs/redesign/designs/Searching.dc.html and PhoneSearching.dc.html.
 * Left: "You asked", the devotee's own question, and four steps —
 *   I   Understanding your question
 *   II  Searching the books, lectures and letters
 *   III Weighing every passage
 *   IV  Checking each quote against its source
 * driven ONLY by the real SSE stage events (understood → searching →
 * reranking → verifying / weaving). There is no timer that advances a step: a
 * step completes when the next real event arrives, and the current step shows
 * a soft running light, not an invented percentage. If the stream is
 * unavailable (plain-fetch fallback) the screen honestly stays on step I until
 * the answer arrives. The live found-count replaces the library line once the
 * search has counted its passages.
 *
 * Right: the disciplic succession from public/data/lineage.json — one name
 * every 2 seconds in the design's gold ornament frame, from Śrī Caitanya
 * Mahāprabhu to Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura, ending on Śrīla
 * Prabhupāda's photograph, which stays. An entry shows its `image` when the
 * owner adds one; otherwise the ornament and the name only.
 *
 * Accessibility: one narrow live region announces the step; one progressbar
 * carries a single clamped, monotonic integer that reaches 100 only after the
 * result has landed (`done`).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteHeader from "./11-site-header";
import type { SearchStageEvent, SearchStageKey } from "@/app/lib/types/01-search";
import {
  advanceLoaderPercent,
  clampLoaderPercent,
  SEARCH_LOADER_INITIAL_PERCENT,
} from "@/app/lib/26-search-loader-model";
import lineageFile from "@/public/data/lineage.json";

interface LineageEntry { name: string; image: string | null }
const LINEAGE: readonly LineageEntry[] = (lineageFile as { lineage: LineageEntry[] }).lineage;
const SECONDS_PER_NAME = 2;

const STEPS = [
  "Understanding your question",
  "Searching the books, lectures and letters",
  "Weighing every passage",
  "Checking each quote against its source",
] as const;
const NUMERALS = ["I", "II", "III", "IV"] as const;

/** Which visible step each real pipeline stage belongs to. */
const STEP_OF_STAGE: Record<SearchStageKey, number> = {
  understood: 0,
  searching: 1,
  reranking: 2,
  verifying: 3,
  weaving: 3,
};

type StepState = "complete" | "current" | "upcoming";

function Ornament() {
  return (
    <svg aria-hidden="true" width="64" height="20" viewBox="0 0 64 20" fill="none">
      <path d="M0 10h22M42 10h22" stroke="#d9b76a" strokeOpacity="0.55" />
      <path d="M32 2l8 8-8 8-8-8z" stroke="#d9b76a" />
      <circle cx="32" cy="10" r="2" fill="#d9b76a" />
    </svg>
  );
}

function Portrait({ entry, index, last }: { entry: LineageEntry; index: number; last: boolean }) {
  const n = String(index + 1).padStart(2, "0");
  return (
    <div
      className={`asp-port${last ? " asp-port-last" : ""}`}
      style={{ animationDelay: `${index * SECONDS_PER_NAME}s` }}
      aria-hidden="true"
    >
      <div className="asp-port-frame">
        {entry.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="asp-port-img"
            src={entry.image}
            alt=""
            decoding="async"
          />
        ) : (
          <div className="asp-port-panel">
            <Ornament />
          </div>
        )}
      </div>
      <p className="asp-port-name">{entry.name}</p>
      <p className="asp-port-n">
        {n} / {LINEAGE.length}
      </p>
    </div>
  );
}

export default function SearchLoader({
  q,
  stage,
  done,
}: {
  q: string;
  /** Latest validated SSE event; null while SSE is unavailable or starting. */
  stage: SearchStageEvent | null;
  /** True only after the result has landed. */
  done: boolean;
}) {
  const [progressPercent, setProgressPercent] = useState(SEARCH_LOADER_INITIAL_PERCENT);
  const [found, setFound] = useState<number | null>(null);

  const targetPercent = clampLoaderPercent(stage?.pct ?? SEARCH_LOADER_INITIAL_PERCENT, done);

  // One monotonic integer: it never moves backwards and never shows 100 early.
  useEffect(() => {
    setProgressPercent((current) => advanceLoaderPercent(current, targetPercent, done));
  }, [targetPercent, done]);

  // The live count of passages the search has found (from its own events).
  useEffect(() => {
    if (stage?.stage === "searching" && typeof stage.found === "number" && stage.found > 0) {
      setFound(stage.found);
    }
  }, [stage]);

  useEffect(() => {
    setFound(null);
    setProgressPercent(SEARCH_LOADER_INITIAL_PERCENT);
  }, [q]);

  const visiblePercent = done ? 100 : progressPercent;
  const currentStep = done ? STEPS.length : stage ? STEP_OF_STAGE[stage.stage] : 0;
  const stateOf = (index: number): StepState =>
    index < currentStep ? "complete" : index === currentStep ? "current" : "upcoming";
  const activeIndex = Math.min(currentStep, STEPS.length - 1);
  const countLine = found !== null
    ? `${found.toLocaleString("en-US")} passages found so far`
    : "Reading 36 books · 3,700+ lectures · 6,500+ letters";

  return (
    <div className="asp-searching" data-done={done ? "true" : "false"}>
      <div className="asp-searching-inner">
        <div aria-hidden="true" className="asp-layer asp-searching-base" />
        <div aria-hidden="true" className="asp-searching-glow-gold asp-drift" />
        <div aria-hidden="true" className="asp-searching-glow-violet asp-drift" />
        <div aria-hidden="true" className="asp-grain" />

        <SiteHeader right={<Link className="asp-ghost-pill" href="/?entrance=0">Cancel</Link>} />

        <main className="asp-searching-main">
          <div className="asp-searching-grid">
            <div className="asp-searching-head">
              <p className="asp-eyebrow asp-rise">You asked</p>
              <h1 className="asp-searching-q asp-rise" style={{ animationDelay: "100ms" }}>{q}</h1>

              <p id="search-loader-status" className="asp-sr" role="status" aria-live="polite" aria-atomic="true">
                {done ? "Your answer is ready." : STEPS[activeIndex]}
              </p>
              <div
                className="asp-sr"
                role="progressbar"
                aria-label="Search progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={visiblePercent}
                aria-valuetext={`${visiblePercent}% complete`}
              />

              <ol className="asp-steps" aria-label="Search progress steps">
                {STEPS.map((name, index) => {
                  const state = stateOf(index);
                  return (
                    <li key={name} className="asp-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
                      <p className="asp-step-name">
                        <span aria-hidden="true" className="asp-step-num">{NUMERALS[index]}</span>
                        {name}
                        <span className="asp-sr">{state === "complete" ? " (done)" : state === "current" ? " (in progress)" : ""}</span>
                      </p>
                      <div aria-hidden="true" className="asp-step-track">
                        <div className="asp-step-fill" />
                        <div className="asp-step-run" />
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="asp-searching-count">{countLine}</p>
            </div>

            <figure
              className="asp-lineage"
              aria-label="The disciplic succession, from Śrī Caitanya Mahāprabhu to Śrīla Prabhupāda"
            >
              <p className="asp-lineage-kicker">The disciplic succession</p>
              <div className="asp-lineage-stage">
                <div aria-hidden="true" className="asp-lineage-glow" />
                {LINEAGE.map((entry, index) => (
                  <Portrait key={entry.name} entry={entry} index={index} last={index === LINEAGE.length - 1} />
                ))}
                <span className="asp-sr">
                  {LINEAGE.map((entry) => entry.name).join(", ")}.
                </span>
              </div>
              <div aria-hidden="true" className="asp-dots">
                {LINEAGE.map((entry, index) => (
                  <span
                    key={entry.name}
                    className={`asp-dot${index === LINEAGE.length - 1 ? " asp-dot-last" : ""}`}
                    style={{ animationDelay: `${index * SECONDS_PER_NAME}s` }}
                  />
                ))}
              </div>
            </figure>

            <div aria-hidden="true" className="asp-step-phone asp-step" data-state={done ? "complete" : "current"}>
              <p className="asp-step-name">
                <span className="asp-step-num">{NUMERALS[activeIndex]}</span>
                {STEPS[activeIndex]}
              </p>
              <div className="asp-step-track">
                <div className="asp-step-fill" />
                <div className="asp-step-run" />
              </div>
              {found !== null && <p className="asp-step-count">{countLine}</p>}
            </div>
          </div>
        </main>
        <p className="asp-searching-tag">Nothing added. Nothing invented.</p>
      </div>

      <style jsx>{`
        /* Kept beside the component for the loader contract (tests/search-loader.test.ts):
           a full-height, scrollable, safe-area-aware sheet that respects short
           screens and reduced motion. The look itself lives in app/redesign.css. */
        .asp-searching {
          height: 100dvh;
          overflow-y: auto;
          scroll-padding-top: env(safe-area-inset-top);
        }
        @media (max-height: 640px) {
          .asp-searching :global(.asp-searching-main) { align-items: flex-start; }
        }
        @media (prefers-reduced-motion: reduce) {
          .asp-searching { transition: none; }
        }
      `}</style>
    </div>
  );
}
