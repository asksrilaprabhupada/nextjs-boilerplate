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

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import SearchLoader from "./10-search-loader";
import NarrativeResponse from "../results/01-narrative-response";
import IncompleteSearchWarning from "../results/02-incomplete-search-warning";
import SpeakerFilterControls from "../results/03-speaker-filter-controls";
import { buildSearchHref } from "@/app/lib/22-search-navigation";
import type { SearchResults, SearchStageEvent } from "@/app/lib/types/01-search";

// With the cascade in place a search finishes in well under a minute; waiting
// two and a half minutes to tell someone it failed is unkind. The server's
// maxDuration stays 300 s for genuine cold-path headroom.
const TIMEOUT_MS = 150_000;

type Phase = "loading" | "ready" | "error";

/** Why the error card is showing — each case earns different honest copy. */
type FailureKind = "dropped" | "server" | "timeout";

export default function SearchExperience({ q, onlyHis = false }: { q: string; onlyHis?: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [failureKind, setFailureKind] = useState<FailureKind>("timeout");
  const [stage, setStage] = useState<SearchStageEvent | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [viewMode, setViewMode] = useState<"article" | "references">("article");
  const [followUp, setFollowUp] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const doneRef = useRef(false);

  const onSearch = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) return;
      router.push(buildSearchHref(trimmed, onlyHis));
    },
    [onlyHis, router],
  );

  useEffect(() => {
    doneRef.current = false;
    setPhase("loading");
    setStage(null);
    setResults(null);
    setViewMode("article");
    window.scrollTo({ top: 0 });

    let es: EventSource | null = null;
    let settled = false;
    // EventSource auto-reconnects on ANY drop, and a naive fallback turns one
    // expensive search into two. A terminal state — result delivered, or an
    // explicit failure frame — is final: close and stop. Only a connection that
    // died BEFORE any stage frame arrived is worth one plain-fetch retry, and
    // only ever one.
    let fellBack = false;

    const queryString = `q=${encodeURIComponent(q)}${onlyHis ? "&only_his=1" : ""}`;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      es?.close();
      clearTimeout(timeout);
    };
    const finish = (r: SearchResults) => settle(() => {
      doneRef.current = true;
      setResults(r);
      setPhase("ready");
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
        sawEvent = true;
        try { setStage(JSON.parse((e as MessageEvent).data)); } catch { /* malformed frame */ }
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
    };
  }, [q, onlyHis, retryNonce]);

  const answered = phase === "ready" && !!results;
  const ans = answered ? { op: 1, ty: "0px", rule: "160px" } : { op: 0, ty: "26px", rule: "0px" };

  const passageCount = results?.passages?.length || 0;
  const additionalCount = results?.additionalCount ?? results?.additional?.length ?? 0;
  const variants = (results?.queryVariants || []).slice(0, 6);
  const speakerFiltered = results?.speakerFilter
    ? results.speakerFilter === "prabhupada_segments"
    : onlyHis;

  const submitFollowUp = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(followUp);
  };

  return (
    <div>
      <SiteHeader variant="solid" />

      {phase === "loading" && <SearchLoader q={q} stage={stage} done={doneRef.current} />}

      <main style={{ maxWidth: 780, margin: "0 auto", padding: "110px clamp(20px,5vw,40px) 80px" }}>
        {/* ═══════ ERROR CARD — honest, never sample verses ═══════
             Three distinct failures, three distinct truths: a lost connection
             (retry may well succeed — the finished answer is often cached), a
             server-side failure (an identical retry will likely fail
             identically, and the card says so), and a timeout. */}
        {phase === "error" && (
          <div style={{ maxWidth: 560, margin: "10vh auto 0", textAlign: "center", background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(32px,5vw,48px)", boxShadow: "0 2px 6px rgba(43,37,25,0.04), 0 16px 44px rgba(43,37,25,0.07)" }}>
            <p className="font-display" style={{ fontSize: "clamp(22px,3vw,28px)", fontWeight: 600, color: "#201B12", margin: 0 }}>
              {failureKind === "dropped" && "The connection was lost."}
              {failureKind === "server" && "The search failed."}
              {failureKind === "timeout" && "The library didn’t answer in time."}
            </p>
            <p className="font-body" style={{ fontSize: 14.5, lineHeight: 1.7, color: "#6E6353", margin: "12px 0 24px" }}>
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
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => setRetryNonce((n) => n + 1)}
                className="font-body"
                style={{ fontSize: 14, fontWeight: 600, color: "#FFFFFF", background: "linear-gradient(135deg, #6B57C9, #51409A)", border: "none", borderRadius: 100, padding: "11px 24px", cursor: "pointer" }}
              >
                Try again
              </button>
              <Link href="/?entrance=0" className="font-body" style={{ fontSize: 14, fontWeight: 600, color: "#6E6353", border: "1px solid #E8E0D2", borderRadius: 100, padding: "11px 24px", textDecoration: "none" }}>
                New search
              </Link>
            </div>
          </div>
        )}

        {answered && results && (
          <>
            {/* Follow-up bar */}
            <form onSubmit={submitFollowUp} style={{ position: "sticky", top: 68, zIndex: 60, marginBottom: "clamp(40px,7vh,64px)", opacity: ans.op, transition: "opacity 0.8s ease 0.1s" }}>
              <div style={{ position: "relative", borderRadius: 16, padding: 1.5, background: "linear-gradient(135deg, rgba(107,87,201,0.42), rgba(201,162,75,0.28))", boxShadow: "0 8px 30px rgba(43,37,25,0.10)" }}>
                <input value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Ask a follow-up" placeholder="Ask a follow-up question…" className="font-body" style={{ width: "100%", display: "block", padding: "14px 108px 14px 20px", fontSize: 15, border: "none", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none" }} />
                <Link href="/?entrance=0" aria-label="New search" title="New search" className="cine-newsearch" style={{ position: "absolute", right: 52, top: 8, width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#6E6353", textDecoration: "none", transition: "all 0.2s ease" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </Link>
                <button type="submit" aria-label="Search" className="cine-submit-btn" style={{ position: "absolute", right: 8, top: 8, width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </form>

            {/* You asked */}
            <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color: "#6B57C9", marginBottom: 18, opacity: ans.op, transform: `translateY(${ans.ty})`, transition: "opacity 0.8s cubic-bezier(0.16,1,0.3,1) 0.05s, transform 0.8s cubic-bezier(0.16,1,0.3,1) 0.05s" }}>You asked</p>
            <h1 className="font-display" style={{ fontSize: "clamp(30px,4.6vw,54px)", fontWeight: 600, lineHeight: 1.12, letterSpacing: "-0.02em", color: "#201B12", textWrap: "pretty", opacity: ans.op, transform: `translateY(${ans.ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.15s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.15s" }}>{results.query || q}</h1>
            <div aria-hidden style={{ width: ans.rule, height: 1, background: "linear-gradient(90deg, #C9A24B, rgba(201,162,75,0))", margin: "26px 0", transition: "width 1.3s cubic-bezier(0.16,1,0.3,1) 0.5s" }} />

            {/* A partial answer must announce itself before counts or teaching text. */}
            <IncompleteSearchWarning sources={results.degradedSources ?? []} />

            {/* Counts plus speaker-filter control. The control remains visible
                at zero results so a filtered empty search can be broadened. */}
            <SpeakerFilterControls
              passageCount={passageCount}
              additionalCount={additionalCount}
              onlyHis={onlyHis}
              speakerFiltered={speakerFiltered}
              onToggle={() => router.push(buildSearchHref(q, !onlyHis))}
            />

            {/* The woven answer — fully data-driven */}
            <NarrativeResponse
              results={results}
              isLoading={false}
              onSearch={onSearch}
              searchLogId={results.searchLogId || null}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />

            {/* Ask next — variant questions from the multi-query expansion */}
            {variants.length > 0 && (
              <section aria-label="Ask next" style={{ marginTop: "clamp(36px,6vh,52px)" }}>
                <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "#9A8F7D", marginBottom: 12 }}>Ask next</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {variants.map((v) => (
                    <button
                      key={v}
                      onClick={() => onSearch(v)}
                      className="cine-source-link font-body"
                      style={{ fontSize: 13, fontWeight: 500, color: "#51409A", background: "rgba(107,87,201,0.06)", border: "1px solid #E8E0D2", borderRadius: 100, padding: "9px 16px", cursor: "pointer", transition: "all 0.3s ease", textAlign: "left" }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
