/**
 * 10-search-loader.tsx — source-grounded, SSE-driven search progress.
 *
 * The visible stages use the same canonical order as the stream. One clamped,
 * monotonic integer drives the bar, its text, and its accessible value. The
 * loader can reach 100 only after `done` says the result is ready.
 */
"use client";

import { useEffect, useState } from "react";
import type { SearchStageEvent } from "@/app/lib/types/01-search";
import { SEARCH_PROGRESS_LABELS } from "@/app/lib/24-search-progress";
import {
  advanceLoaderPercent,
  clampLoaderPercent,
  PREMA_PASSAGE_CANDIDATES,
  SEARCH_LOADER_FALLBACK_STAGES,
  SEARCH_LOADER_INITIAL_PERCENT,
  SEARCH_LOADER_STAGES,
} from "@/app/lib/26-search-loader-model";

const MANDALA = Array.from({ length: 12 }, (_, i) => i * 30);

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    try {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReduced(media.matches);
      update();
      media.addEventListener?.("change", update);
      return () => media.removeEventListener?.("change", update);
    } catch {
      return undefined;
    }
  }, []);

  return reduced;
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
  const [fallbackStage, setFallbackStage] = useState<SearchStageEvent>(
    SEARCH_LOADER_FALLBACK_STAGES[0],
  );
  const [passageIndex, setPassageIndex] = useState(0);
  const reduced = useReducedMotion();

  // Plain-fetch fallback: mirror the real five-stage order and remain below
  // completion. A genuine SSE event always takes precedence as soon as it lands.
  useEffect(() => {
    if (stage || done) return;
    let index = 0;
    const interval = window.setInterval(() => {
      index += 1;
      if (index >= SEARCH_LOADER_FALLBACK_STAGES.length) {
        window.clearInterval(interval);
        return;
      }
      setFallbackStage(SEARCH_LOADER_FALLBACK_STAGES[index]);
    }, 4500);
    return () => window.clearInterval(interval);
  }, [stage, done, q]);

  const active = stage ?? fallbackStage;
  const activeIndex = Math.max(
    0,
    SEARCH_LOADER_STAGES.findIndex(({ key }) => key === active?.stage),
  );
  const targetPercent = clampLoaderPercent(
    active?.pct ?? SEARCH_LOADER_INITIAL_PERCENT,
    done,
  );

  // Animate only between integer values. Reduced motion jumps to the same
  // monotonic target, never to a different semantic value.
  useEffect(() => {
    if (done || reduced) {
      const timeout = window.setTimeout(() => {
        setProgressPercent((current) => advanceLoaderPercent(current, targetPercent, done));
      }, 0);
      return () => window.clearTimeout(timeout);
    }

    const interval = window.setInterval(() => {
      setProgressPercent((current) => {
        const goal = advanceLoaderPercent(current, targetPercent, false);
        if (current >= goal) {
          window.clearInterval(interval);
          return current;
        }
        const step = Math.max(1, Math.ceil((goal - current) * 0.12));
        return advanceLoaderPercent(current, current + step, false);
      });
    }, 32);
    return () => window.clearInterval(interval);
  }, [targetPercent, reduced, done]);

  // Source-checked passages rotate only when motion is welcome.
  useEffect(() => {
    if (reduced) return;
    const interval = window.setInterval(
      () => setPassageIndex((index) => (index + 1) % PREMA_PASSAGE_CANDIDATES.length),
      8000,
    );
    return () => window.clearInterval(interval);
  }, [reduced]);

  const visiblePercent = done ? 100 : progressPercent;
  const passage = PREMA_PASSAGE_CANDIDATES[passageIndex];

  return (
    <div
      className="cine-search-loader"
      data-done={done ? "true" : "false"}
      data-reduced={reduced ? "true" : "false"}
    >
      <div className="cine-search-loader__inner">
        <div className="cine-search-loader__mandala">
          <div className="cine-search-loader__aura" aria-hidden="true" />
          <svg viewBox="0 0 400 400" aria-hidden="true">
            {MANDALA.map((degrees) => (
              <g key={degrees} transform={`rotate(${degrees} 200 200)`}>
                <ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.6" />
              </g>
            ))}
            <circle cx="200" cy="200" r="70" fill="none" stroke="currentColor" strokeWidth="0.5" />
          </svg>
          <p
            id="search-loader-status"
            className="cine-search-loader__status font-display"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {active?.label ?? SEARCH_PROGRESS_LABELS.idle}
          </p>
        </div>

        <p className="cine-search-loader__question font-body">&ldquo;{q}&rdquo;</p>

        {typeof stage?.found === "number" && stage.found > 0 && (
          <p className="cine-search-loader__found font-body">
            {stage.found.toLocaleString("en-US")} passages so far
          </p>
        )}

        <ol className="cine-search-loader__stages" aria-label="Search progress stages">
          {SEARCH_LOADER_STAGES.map(({ key, name }, index) => {
            const passed = done || index < activeIndex;
            const current = !done && index === activeIndex;
            const state = passed ? "complete" : current ? "current" : "upcoming";
            return (
              <li
                key={key}
                aria-current={current ? "step" : undefined}
                aria-label={`${name}: ${state}`}
              >
                <span className={`cine-search-loader__dot cine-search-loader__dot--${state}`} aria-hidden="true" />
                <span className={`font-body cine-search-loader__stage-name cine-search-loader__stage-name--${state}`}>
                  {name}
                </span>
              </li>
            );
          })}
        </ol>

        <div
          className="cine-search-loader__progress"
          role="progressbar"
          aria-label="Search progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={visiblePercent}
          aria-valuetext={`${visiblePercent}% complete`}
        >
          <span className="cine-search-loader__track" aria-hidden="true">
            <span className="cine-search-loader__fill" style={{ width: `${visiblePercent}%` }} />
          </span>
          <span className="cine-search-loader__percent font-body">{visiblePercent}%</span>
        </div>

        <figure
          key={reduced ? "static" : passage.id}
          className={`cine-search-loader__passage${reduced ? "" : " cine-search-loader__passage--animated"}`}
        >
          <blockquote className="font-display">&ldquo;{passage.text}&rdquo;</blockquote>
          <figcaption className="font-body">
            <span className="cine-search-loader__source">
              <cite>{passage.work}</cite> {passage.reference} · {passage.author}
            </span>
            <span>{passage.translatorAttribution}</span>
            <span>
              English source: {passage.translationSource} ·{" "}
              <a href={passage.verification.passageUrl} target="_blank" rel="noreferrer">
                verify source
              </a>
            </span>
          </figcaption>
        </figure>
      </div>

      <style jsx>{`
        .cine-search-loader {
          position: fixed;
          inset: 0;
          z-index: 800;
          width: 100%;
          height: 100dvh;
          overflow-y: auto;
          overscroll-behavior: contain;
          background: rgba(250, 247, 241, 0.97);
          opacity: 1;
          transition: opacity 0.35s ease;
        }
        .cine-search-loader[data-done="true"] {
          opacity: 0;
          pointer-events: none;
        }
        .cine-search-loader__inner {
          box-sizing: border-box;
          width: 100%;
          min-height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: max(16px, env(safe-area-inset-top))
            max(16px, env(safe-area-inset-right))
            max(16px, env(safe-area-inset-bottom))
            max(16px, env(safe-area-inset-left));
        }
        .cine-search-loader__mandala {
          position: relative;
          flex: 0 0 auto;
          width: min(56vw, 220px);
          height: min(56vw, 220px);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cine-search-loader__aura {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 130%;
          height: 130%;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(139, 110, 224, 0.24) 0%, rgba(201, 162, 75, 0.11) 42%, transparent 70%);
          filter: blur(38px);
          animation: auraBreathe 4.5s ease-in-out infinite;
        }
        .cine-search-loader__mandala svg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          color: #6b57c9;
          opacity: 0.15;
          animation: rotateMandala 60s linear infinite;
        }
        .cine-search-loader__status {
          position: relative;
          max-width: 220px;
          margin: 0;
          color: #51409a;
          font-size: clamp(17px, 2.4vw, 21px);
          font-style: italic;
          text-align: center;
        }
        .cine-search-loader__question {
          max-width: 460px;
          margin: 8px 0 0;
          color: #9a8f7d;
          font-size: 13px;
          line-height: 1.45;
          overflow-wrap: anywhere;
          text-align: center;
        }
        .cine-search-loader__found {
          margin: 10px 0 0;
          color: #6e6353;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
        }
        .cine-search-loader__stages {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 14px;
          margin: 20px 0 0;
          padding: 0;
          list-style: none;
        }
        .cine-search-loader__stages li {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .cine-search-loader__dot {
          box-sizing: border-box;
          width: 8px;
          height: 8px;
          flex: 0 0 auto;
          border: 1.5px solid #d8ccb8;
          border-radius: 50%;
          background: transparent;
          transition: background 0.4s, border-color 0.4s;
        }
        .cine-search-loader__dot--complete {
          border-color: #6b57c9;
          background: #6b57c9;
        }
        .cine-search-loader__dot--current {
          border-color: #c9a24b;
          background: #c9a24b;
        }
        .cine-search-loader__stage-name {
          color: #b9ae99;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          transition: color 0.4s;
        }
        .cine-search-loader__stage-name--complete { color: #6e6353; }
        .cine-search-loader__stage-name--current { color: #51409a; }
        .cine-search-loader__progress {
          display: flex;
          align-items: center;
          gap: 10px;
          width: min(80vw, 340px);
          margin-top: 16px;
        }
        .cine-search-loader__track {
          height: 3px;
          flex: 1;
          overflow: hidden;
          border-radius: 100px;
          background: rgba(107, 87, 201, 0.12);
        }
        .cine-search-loader__fill {
          display: block;
          height: 100%;
          border-radius: 100px;
          background: linear-gradient(90deg, #6b57c9, #c9a24b);
          transition: width 0.2s linear;
        }
        .cine-search-loader__percent {
          min-width: 34px;
          color: #9a8f7d;
          font-size: 11.5px;
          font-weight: 600;
          text-align: right;
        }
        .cine-search-loader__passage {
          width: min(100%, 620px);
          margin: 26px 0 0;
          color: #6b6151;
          opacity: 0.92;
          text-align: center;
        }
        .cine-search-loader__passage--animated {
          animation: cineWaitPassage 8s ease both;
        }
        .cine-search-loader__passage blockquote {
          margin: 0;
          font-size: clamp(14px, 1.7vw, 16.5px);
          font-style: italic;
          line-height: 1.6;
        }
        .cine-search-loader__passage figcaption {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
          max-width: 100%;
          margin-top: 8px;
          color: #817765;
          font-size: 11px;
          font-weight: 600;
          line-height: 1.45;
          letter-spacing: 0.035em;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .cine-search-loader__passage figcaption span,
        .cine-search-loader__passage figcaption cite,
        .cine-search-loader__passage figcaption a {
          min-width: 0;
          max-width: 100%;
          overflow-wrap: anywhere;
        }
        .cine-search-loader__source {
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .cine-search-loader__source cite { font-style: normal; }
        .cine-search-loader__passage a {
          color: #51409a;
          text-underline-offset: 2px;
        }
        @keyframes cineWaitPassage {
          0% { opacity: 0; transform: translateY(6px); }
          6% { opacity: 0.92; transform: translateY(0); }
          94% { opacity: 0.92; }
          100% { opacity: 0; }
        }
        @media (max-height: 640px) {
          .cine-search-loader__inner { justify-content: flex-start; }
          .cine-search-loader__mandala { width: 148px; height: 148px; }
          .cine-search-loader__stages { margin-top: 12px; }
          .cine-search-loader__progress { margin-top: 10px; }
          .cine-search-loader__passage { margin-top: 16px; }
        }
        @media (max-width: 360px) {
          .cine-search-loader__stages { column-gap: 9px; row-gap: 7px; }
          .cine-search-loader__stage-name { font-size: 9px; letter-spacing: 0.08em; }
          .cine-search-loader__passage figcaption { font-size: 10px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .cine-search-loader[data-done="true"] { opacity: 1; }
          .cine-search-loader,
          .cine-search-loader__dot,
          .cine-search-loader__stage-name,
          .cine-search-loader__fill { transition: none; }
          .cine-search-loader__aura,
          .cine-search-loader__mandala svg,
          .cine-search-loader__passage--animated { animation: none; }
        }
      `}</style>
    </div>
  );
}
