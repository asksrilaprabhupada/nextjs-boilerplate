/**
 * 09-search-experience.tsx — Live Search Experience (client orchestrator)
 *
 * The destination of the home page's search. Opens the /api/search SSE stream
 * for the question in `q`, drives the meditative loader from real pipeline
 * stage events, then renders the woven answer with the data-driven renderer
 * (components/results/01-narrative-response) inside the cinematic chrome —
 * header, "You asked" headline, follow-up bar. A stream that never started
 * earns exactly one plain-fetch retry; a stream that died mid-search is
 * terminal and says so honestly. It never falls back to sample verses.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import SearchLoader from "./10-search-loader";
import NarrativeResponse from "../results/01-narrative-response";
import IncompleteSearchWarning from "../results/02-incomplete-search-warning";
import { buildSearchHref } from "@/app/lib/22-search-navigation";
import type { SearchResults, SearchStageEvent } from "@/app/lib/types/01-search";
import {
  advanceSearchStage,
  parseSearchStageEvent,
} from "@/app/lib/25-search-stage-events";

// With the cascade in place a search finishes in well under a minute; waiting
// two and a half minutes to tell someone it failed is unkind. The server's
// maxDuration stays 300 s for genuine cold-path headroom.
const TIMEOUT_MS = 150_000;
const COMPLETION_HOLD_MS = 400;

type Phase = "loading" | "completing" | "ready" | "error";

/** Why the error card is showing — each case earns different honest copy. */
type FailureKind = "dropped" | "server" | "timeout";

export default function SearchExperience({ q }: { q: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [failureKind, setFailureKind] = useState<FailureKind>("timeout");
  const [stage, setStage] = useState<SearchStageEvent | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [viewMode, setViewMode] = useState<"article" | "references">("article");
  const [followUp, setFollowUp] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);

  const onSearch = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) return;
      router.push(buildSearchHref(trimmed));
    },
    [router],
  );

  useEffect(() => {
    setPhase("loading");
    setStage(null);
    setResults(null);
    setViewMode("article");
    window.scrollTo({ top: 0 });

    let es: EventSource | null = null;
    let settled = false;
    let completionTimer: ReturnType<typeof setTimeout> | null = null;
    // EventSource auto-reconnects on ANY drop, and a naive fallback turns one
    // expensive search into two. A terminal state — result delivered, or an
    // explicit failure frame — is final: close and stop. Only a connection that
    // died BEFORE any stage frame arrived is worth one plain-fetch retry, and
    // only ever one.
    let fellBack = false;

    const queryString = `q=${encodeURIComponent(q)}`;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      es?.close();
      clearTimeout(timeout);
    };
    const finish = (r: SearchResults) => settle(() => {
      setResults(r);
      // Keep the completed loader mounted briefly so its one shared value can
      // truthfully show 100 before the ready answer replaces it.
      setPhase("completing");
      completionTimer = setTimeout(() => setPhase("ready"), COMPLETION_HOLD_MS);
    });
    const fail = (kind: FailureKind) => settle(() => {
      setFailureKind(kind);
      setPhase("error");
    });

    const fallbackFetch = async () => {
      if (fellBack) return;
      fellBack = true;
      try {
        const res = await fetch(`/api/search?${queryString}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SearchResults & { error?: string };
        if (data.error) throw new Error(data.error);
        finish(data);
      } catch (err) {
        console.error("[search] fallback fetch failed:", err);
        fail("server");
      }
    };

    const timeout = setTimeout(() => {
      console.error(`[search] no answer within ${TIMEOUT_MS / 1000}s`);
      fail("timeout");
    }, TIMEOUT_MS);

    if (typeof EventSource !== "undefined") {
      es = new EventSource(`/api/search?${queryString}&stream=1`);
      let sawEvent = false;
      es.addEventListener("stage", (e) => {
        try {
          const incoming = parseSearchStageEvent(JSON.parse((e as MessageEvent).data));
          if (incoming) {
            sawEvent = true;
            setStage((current) => advanceSearchStage(current, incoming));
          }
        } catch { /* malformed frame */ }
      });
      es.addEventListener("result", (e) => {
        try {
          finish(JSON.parse((e as MessageEvent).data));
        } catch {
          fail("server");
        }
        // settle() closed the stream; closing again here is a harmless no-op
        // that makes the intent explicit — a delivered result is terminal.
        es?.close();
      });
      es.addEventListener("failure", () => fail("server"));
      es.addEventListener("done", () => es?.close());
      es.onerror = () => {
        if (settled) return;
        es?.close();
        if (sawEvent) {
          // The stream was alive and delivering stages: the search was already
          // running server-side. Re-running it would double the cost and hide
          // the real error, so the drop is terminal.
          console.error("[search] SSE dropped mid-stream — not retrying");
          fail("dropped");
          return;
        }
        // The stream never started, so nothing expensive has run yet — worth
        // one plain fetch, which also serves the no-EventSource path below.
        console.warn("[search] SSE unavailable — one plain-fetch fallback");
        void fallbackFetch();
      };
    } else {
      void fallbackFetch();
    }

    return () => {
      settled = true;
      es?.close();
      clearTimeout(timeout);
      if (completionTimer) clearTimeout(completionTimer);
    };
  }, [q, retryNonce]);

  const answered = phase === "ready" && !!results;

  const passageCount = results?.passages?.length || 0;
  const additionalCount = results?.additionalCount ?? results?.additional?.length ?? 0;
  const variants = (results?.queryVariants || []).slice(0, 6);

  const submitFollowUp = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(followUp);
  };

  return (
    <div className="search-experience">
      <SiteHeader variant="solid" />

      {(phase === "loading" || phase === "completing") && (
        <SearchLoader q={q} stage={stage} done={phase === "completing"} />
      )}

      <main className="search-experience__main">
        {/* ═══════ ERROR CARD — honest, never sample verses ═══════
             Three distinct failures, three distinct truths: a lost connection
             (retry may well succeed — the finished answer is often cached), a
             server-side failure (an identical retry will likely fail
             identically, and the card says so), and a timeout. */}
        {phase === "error" && (
          <div className="search-error" role="alert" aria-live="assertive">
            <p className="search-error__title font-display">
              {failureKind === "dropped" && "The connection was lost."}
              {failureKind === "server" && "The search failed."}
              {failureKind === "timeout" && "The library didn’t answer in time."}
            </p>
            <p className="search-error__message font-body">
              {failureKind === "dropped" && (
                <>Your question &ldquo;{q}&rdquo; was being answered when the connection dropped. The answer may already be waiting — trying again is usually quick.</>
              )}
              {failureKind === "server" && (
                <>Your question &ldquo;{q}&rdquo; reached the library, but the search failed on our side. An identical retry will most likely fail the same way — if it does, please try again in a few minutes.</>
              )}
              {failureKind === "timeout" && (
                <>Your question &ldquo;{q}&rdquo; reached the library, but no answer came back in time. Nothing is wrong with your question — please try again.</>
              )}
            </p>
            <div className="search-error__actions">
              <button
                onClick={() => setRetryNonce((n) => n + 1)}
                className="search-error__action search-error__action--primary font-body"
              >
                Try again
              </button>
              <Link href="/?entrance=0" className="search-error__action search-error__action--secondary font-body">
                New search
              </Link>
            </div>
          </div>
        )}

        {answered && results && (
          <div className="search-answer">
            {/* Follow-up bar */}
            <form onSubmit={submitFollowUp} className="search-followup">
              <div className="search-followup__frame">
                <input value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Ask a follow-up" placeholder="Ask a follow-up question…" className="search-followup__input font-body" />
                <Link href="/?entrance=0" aria-label="New search" title="New search" className="search-followup__control search-followup__new cine-newsearch">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </Link>
                <button type="submit" aria-label="Search" className="search-followup__control search-followup__submit cine-submit-btn">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </form>

            {/* You asked */}
            <p className="search-answer__eyebrow font-body">You asked</p>
            <h1 className="search-answer__title font-display">{results.query || q}</h1>
            <div className="search-answer__rule" aria-hidden />

            {/* A partial answer must announce itself before counts or teaching text. */}
            <IncompleteSearchWarning
              sources={results.degradedSources ?? []}
              degraded={results.degraded}
            />

            {/* Honest result counts, without filtering the recorded conversation. */}
            {passageCount > 0 ? (
              <div className="search-answer__counts">
                <span className="search-answer__count font-body">
                  {passageCount} {passageCount === 1 ? "passage" : "passages"} in full
                  {additionalCount > 0 ? <> · {additionalCount.toLocaleString("en-US")} more as citations below</> : null}
                </span>
              </div>
            ) : null}

            {/* The woven answer — fully data-driven */}
            <div className="search-answer__results">
              <NarrativeResponse
                results={results}
                isLoading={false}
                onSearch={onSearch}
                searchLogId={results.searchLogId || null}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
              />
            </div>

            {/* Ask next — variant questions from the multi-query expansion */}
            {variants.length > 0 && (
              <section aria-label="Ask next" className="search-answer__next">
                <p className="search-answer__next-label font-body">Ask next</p>
                <div className="search-answer__next-list">
                  {variants.map((v) => (
                    <button
                      key={v}
                      onClick={() => onSearch(v)}
                      className="search-answer__next-button cine-source-link font-body"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      <SiteFooter />

      <style jsx global>{`
        .search-experience {
          min-width: 0;
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
        }

        .search-experience__main {
          box-sizing: border-box;
          width: 100%;
          max-width: 780px;
          min-width: 0;
          flex: 1;
          margin: 0 auto;
          padding-top: calc(110px + env(safe-area-inset-top));
          padding-right: max(clamp(16px, 4vw, 40px), env(safe-area-inset-right));
          padding-bottom: max(80px, env(safe-area-inset-bottom));
          padding-left: max(clamp(16px, 4vw, 40px), env(safe-area-inset-left));
        }

        .search-error {
          width: 100%;
          max-width: 560px;
          margin: min(10vh, 80px) auto 0;
          padding: clamp(28px, 5vw, 48px);
          overflow-wrap: anywhere;
          text-align: center;
          background: #fefcf8;
          border: 1px solid #e8e0d2;
          border-radius: 18px;
          box-shadow: 0 2px 6px rgba(43, 37, 25, 0.04), 0 16px 44px rgba(43, 37, 25, 0.07);
        }

        .search-error__title {
          margin: 0;
          color: #201b12;
          font-size: clamp(22px, 3vw, 28px);
          font-weight: 600;
        }

        .search-error__message {
          margin: 12px 0 24px;
          color: #6e6353;
          font-size: 14.5px;
          line-height: 1.7;
        }

        .search-error__actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 10px;
        }

        .search-error__action {
          min-width: 124px;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 10px 22px;
          border-radius: 100px;
          font-size: 14px;
          font-weight: 600;
          line-height: 1.2;
          text-decoration: none;
          cursor: pointer;
        }

        .search-error__action--primary {
          color: #fff;
          background: linear-gradient(135deg, #6b57c9, #51409a);
          border: none;
        }

        .search-error__action--secondary {
          color: #6e6353;
          background: #fefcf8;
          border: 1px solid #e8e0d2;
        }

        .search-answer,
        .search-answer__results {
          min-width: 0;
        }

        .search-followup {
          position: sticky;
          top: calc(68px + env(safe-area-inset-top));
          z-index: 60;
          width: 100%;
          min-width: 0;
          margin-bottom: clamp(40px, 7vh, 64px);
          animation: search-answer-fade 0.8s ease 0.1s both;
        }

        .search-followup__frame {
          position: relative;
          min-width: 0;
          padding: 1.5px;
          border-radius: 16px;
          background: linear-gradient(135deg, rgba(107, 87, 201, 0.42), rgba(201, 162, 75, 0.28));
          box-shadow: 0 8px 30px rgba(43, 37, 25, 0.1);
        }

        .search-followup__input {
          width: 100%;
          min-width: 0;
          min-height: 54px;
          display: block;
          padding: 14px 108px 14px 18px;
          overflow-wrap: anywhere;
          color: #2b2519;
          background: #fefcf8;
          border: none;
          border-radius: 14px;
          outline: none;
          font-size: 16px;
        }

        .search-followup__control {
          position: absolute;
          top: 6px;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 11px;
          text-decoration: none;
          cursor: pointer;
          transition: background 0.2s ease, color 0.2s ease, transform 0.3s ease;
        }

        .search-followup__new {
          right: 52px;
          color: #6e6353;
        }

        .search-followup__submit {
          right: 6px;
          color: #fff;
          background: linear-gradient(135deg, #6b57c9, #51409a);
          border: none;
        }

        .search-answer__eyebrow {
          margin: 0 0 18px;
          color: #6b57c9;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.32em;
          text-transform: uppercase;
          animation: search-answer-rise 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both;
        }

        .search-answer__title {
          margin: 0;
          overflow-wrap: anywhere;
          color: #201b12;
          font-size: clamp(30px, 4.6vw, 54px);
          font-weight: 600;
          line-height: 1.12;
          letter-spacing: -0.02em;
          text-wrap: pretty;
          animation: search-answer-rise 0.9s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both;
        }

        .search-answer__rule {
          width: min(160px, 44vw);
          height: 1px;
          margin: 26px 0;
          background: linear-gradient(90deg, #c9a24b, rgba(201, 162, 75, 0));
          transform-origin: left;
          animation: search-answer-rule 1.3s cubic-bezier(0.16, 1, 0.3, 1) 0.5s both;
        }

        .search-answer__counts {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          margin-bottom: clamp(36px, 6vh, 54px);
        }

        .search-answer__count {
          max-width: 100%;
          min-height: 36px;
          display: inline-flex;
          align-items: center;
          padding: 7px 14px;
          overflow-wrap: anywhere;
          color: #6e6353;
          background: rgba(107, 87, 201, 0.07);
          border: 1px solid #e8e0d2;
          border-radius: 100px;
          font-size: 12px;
          font-weight: 600;
          line-height: 1.45;
          letter-spacing: 0.06em;
        }

        .search-answer__next {
          min-width: 0;
          margin-top: clamp(36px, 6vh, 52px);
        }

        .search-answer__next-label {
          margin: 0 0 12px;
          color: #9a8f7d;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .search-answer__next-list {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          min-width: 0;
        }

        .search-answer__next-button {
          max-width: 100%;
          min-height: 44px;
          display: inline-flex;
          align-items: center;
          padding: 10px 16px;
          overflow-wrap: anywhere;
          white-space: normal;
          color: #51409a;
          background: rgba(107, 87, 201, 0.06);
          border: 1px solid #e8e0d2;
          border-radius: 22px;
          font-size: 13px;
          font-weight: 500;
          line-height: 1.4;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.3s ease, color 0.3s ease, background 0.3s ease;
        }

        .search-error__action:focus-visible,
        .search-followup__input:focus-visible,
        .search-followup__control:focus-visible,
        .search-answer__next-button:focus-visible {
          outline: 3px solid rgba(107, 87, 201, 0.5);
          outline-offset: 3px;
        }

        @keyframes search-answer-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes search-answer-rise {
          from { opacity: 0; transform: translateY(26px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes search-answer-rule {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }

        @media (max-width: 480px) {
          .search-experience__main {
            padding-top: calc(94px + env(safe-area-inset-top));
          }

          .search-error {
            margin-top: 24px;
            padding: 26px 18px;
          }

          .search-error__action {
            flex: 1 1 140px;
          }

          .search-followup {
            margin-bottom: 38px;
          }

          .search-answer__next-button {
            flex: 1 1 100%;
          }
        }

        @media (max-height: 500px) and (orientation: landscape) {
          .search-experience__main {
            padding-top: calc(76px + env(safe-area-inset-top));
            padding-bottom: max(32px, env(safe-area-inset-bottom));
          }

          .search-error {
            margin-top: 8px;
            padding: 20px 24px;
          }

          .search-error__message {
            margin-bottom: 16px;
          }

          .search-followup {
            top: calc(62px + env(safe-area-inset-top));
            margin-bottom: 28px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .search-followup,
          .search-answer__eyebrow,
          .search-answer__title,
          .search-answer__rule {
            animation: none;
          }

          .search-followup__control,
          .search-answer__next-button {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}
