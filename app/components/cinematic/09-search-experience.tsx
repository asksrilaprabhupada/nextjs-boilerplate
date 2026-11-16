/**
 * 09-search-experience.tsx — Live Search Experience (client orchestrator)
 *
 * The destination of the home page's search. Opens the /api/search SSE stream
 * for the question in `q`, drives the Searching screen from real pipeline stage
 * events, then shows the Answer (cinematic redesign: dark band with "You
 * asked" and the devotee's own question, then the passages from
 * components/results/01-narrative-response). Dig Deeper opens as its own screen
 * from the answer's card (#dig-deeper, so the phone's Back returns to the
 * answer). A stream that never started earns exactly one plain-fetch retry; a
 * stream that died mid-search is terminal and says so honestly. It never falls
 * back to sample verses, and nothing here is written by a model: the old "Ask
 * next" suggestions (planner-written questions) are no longer shown.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import SearchLoader from "./10-search-loader";
import ThemeToggle from "../layout/03-theme-toggle";
import NarrativeResponse from "../results/01-narrative-response";
import IncompleteSearchWarning from "../results/02-incomplete-search-warning";
import DigDeeperPage, { type DigSource } from "../results/03-cinematic-dig-deeper";
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
const DIG_HASH = "#dig-deeper";

type Phase = "loading" | "completing" | "ready" | "error";

/** Why the error card is showing — each case earns different honest copy. */
type FailureKind = "dropped" | "server" | "timeout";

function SearchIcon({ color = "currentColor", size = 18 }: { color?: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export default function SearchExperience({ q }: { q: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [failureKind, setFailureKind] = useState<FailureKind>("timeout");
  const [stage, setStage] = useState<SearchStageEvent | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [digOpen, setDigOpen] = useState(false);
  const [digSource, setDigSource] = useState<DigSource | null>(null);
  const answerScrollRef = useRef(0);
  const pushedDigRef = useRef(false);

  const onSearch = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) return;
      router.push(buildSearchHref(trimmed));
    },
    [router],
  );

  // Dig Deeper lives at #dig-deeper so Back (or a swipe) returns to the answer.
  useEffect(() => {
    const sync = () => {
      const open = window.location.hash === DIG_HASH;
      if (!open) pushedDigRef.current = false;
      setDigOpen(open);
      if (!open) {
        const y = answerScrollRef.current;
        requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }));
      }
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const openDigDeeper = useCallback((source?: DigSource) => {
    answerScrollRef.current = window.scrollY;
    setDigSource(source ?? null);
    if (window.location.hash !== DIG_HASH) {
      window.history.pushState(window.history.state, "", `${window.location.pathname}${window.location.search}${DIG_HASH}`);
      pushedDigRef.current = true;
    }
    setDigOpen(true);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const closeDigDeeper = useCallback(() => {
    if (window.location.hash === DIG_HASH && pushedDigRef.current) {
      // We added this history entry, so stepping back returns to the answer.
      pushedDigRef.current = false;
      window.history.back();
      return;
    }
    if (window.location.hash === DIG_HASH) {
      // Arrived straight on #dig-deeper (a reload): drop the hash in place.
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }
    setDigOpen(false);
    const y = answerScrollRef.current;
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }));
  }, []);

  useEffect(() => {
    setPhase("loading");
    setStage(null);
    setResults(null);
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

  const showAnswer = (phase === "ready" || phase === "completing") && !!results;

  const passageCount = results?.passages?.length || 0;
  const additionalCount = results?.additionalCount ?? results?.additional?.length ?? 0;

  const submitFollowUp = (e: FormEvent) => {
    e.preventDefault();
    onSearch(followUp);
  };

  if (showAnswer && results && digOpen) {
    return (
      <DigDeeperPage
        key={`${results.query}:${digSource ?? "all"}`}
        q={results.query || q}
        list={results.additional || []}
        totalCount={results.additionalCount}
        truncated={results.additionalTruncated}
        initialSource={digSource}
        onBack={closeDigDeeper}
      />
    );
  }

  const headerRight = (
    <>
      <form className="asp-hsearch" role="search" aria-label="Ask another question" onSubmit={submitFollowUp}>
        <SearchIcon color="rgba(255,248,232,0.75)" />
        <label htmlFor="asp-q-answer" className="asp-sr">Ask another question</label>
        <input
          id="asp-q-answer"
          type="search"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          placeholder="Ask another question"
          autoComplete="off"
          enterKeyHint="search"
        />
      </form>
      <Link className="asp-hicon" href="/?entrance=0" aria-label="Ask another question">
        <SearchIcon />
      </Link>
      <ThemeToggle variant="scene" />
    </>
  );

  return (
    <div className="asp-page search-experience">
      {(phase === "loading" || phase === "completing") && (
        <SearchLoader q={q} stage={stage} done={phase === "completing"} />
      )}

      {/* ═══════ ERROR — honest, never sample verses ═══════
           Three distinct failures, three distinct truths: a lost connection
           (retry may well succeed — the finished answer is often cached), a
           server-side failure (an identical retry will likely fail
           identically, and the card says so), and a timeout. */}
      {phase === "error" && (
        <>
          <section className="asp-dark" aria-label="Your question">
            <div aria-hidden="true" className="asp-layer asp-answer-hero-base" />
            <SiteHeader />
            <div className="asp-answer-head asp-sec">
              <p className="asp-eyebrow">You asked</p>
              <h1 className="asp-answer-q">{q}</h1>
            </div>
            <div aria-hidden="true" className="asp-answer-fade" />
          </section>
          <main className="asp-answer-main asp-sec">
            <div className="asp-panel" role="alert" aria-live="assertive">
              <p className="asp-panel-title">
                {failureKind === "dropped" && "The connection was lost."}
                {failureKind === "server" && "The search failed."}
                {failureKind === "timeout" && "The library didn’t answer in time."}
              </p>
              <p className="asp-panel-text">
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
              <div className="asp-panel-actions">
                <button type="button" className="asp-btn-primary" onClick={() => setRetryNonce((n) => n + 1)}>
                  Try again
                </button>
                <Link href="/?entrance=0" className="asp-btn-ghost">
                  New search
                </Link>
              </div>
            </div>
          </main>
          <SiteFooter />
        </>
      )}

      {showAnswer && results && (
        <>
          <section className="asp-dark" aria-label="Your question">
            <div aria-hidden="true" className="asp-layer asp-answer-hero-base" />
            <div aria-hidden="true" className="asp-answer-glow-gold asp-drift" />
            <div aria-hidden="true" className="asp-answer-glow-violet asp-drift" />
            <div aria-hidden="true" className="asp-answer-glow-phone" />
            <div aria-hidden="true" className="asp-grain asp-grain-10" />

            <SiteHeader right={headerRight} />

            <div className="asp-answer-head asp-sec">
              {/* The devotee's own question. There is no AI title. */}
              <p className="asp-eyebrow asp-rise">You asked</p>
              <h1 className="asp-answer-q asp-rise" style={{ animationDelay: "100ms" }}>{results.query || q}</h1>

              {/* A partial answer must announce itself before counts or teaching text. */}
              <div className="asp-answer-warning">
                <IncompleteSearchWarning
                  sources={results.degradedSources ?? []}
                  degraded={results.degraded}
                  rankingUnavailable={results.rankingUnavailable ?? false}
                />
              </div>

              {/* Honest result counts, without filtering the recorded conversation. */}
              <div className="asp-answer-meta asp-rise" style={{ animationDelay: "220ms" }}>
                <span className="asp-answer-chip">Śrīla Prabhupāda&apos;s books, lectures and letters</span>
                {passageCount > 0 ? (
                  <span className="asp-answer-count">
                    {passageCount} {passageCount === 1 ? "passage" : "passages"} in full
                    {additionalCount > 0 ? <> · {additionalCount.toLocaleString("en-US")} more as citations below</> : null}
                  </span>
                ) : null}
              </div>
            </div>
            <div aria-hidden="true" className="asp-answer-fade" />
          </section>

          <NarrativeResponse
            results={results}
            onSearch={onSearch}
            searchLogId={results.searchLogId || null}
            onOpenDigDeeper={openDigDeeper}
          />

          <SiteFooter />
        </>
      )}
    </div>
  );
}
