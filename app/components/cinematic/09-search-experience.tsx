/**
 * 09-search-experience.tsx — Live Search Experience (client orchestrator)
 *
 * The destination of the home page's search. Opens the /api/search SSE stream
 * for the question in `q`, drives the meditative loader from real pipeline
 * stage events, then renders the woven answer with the data-driven renderer
 * (components/results/01-narrative-response) inside the cinematic chrome —
 * header, "You asked" headline, follow-up bar. On stream failure it falls back
 * to a plain fetch once; if the library still doesn't answer within 330 s it
 * shows an honest error card with a retry. It never falls back to sample
 * verses.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import SearchLoader from "./10-search-loader";
import NarrativeResponse from "../results/01-narrative-response";
import { useSearchBehaviorTracker } from "@/app/hooks/01-use-search-behavior-tracker";
import { logBehavior, logCitationClick } from "@/app/lib/02-analytics";
import type { SearchResults, SearchStageEvent } from "@/app/lib/types/01-search";

// The page must always outlast the server (maxDuration 300 s): giving up while
// the answer is still being made shows a failure that never happened.
const TIMEOUT_MS = 330_000;

type Phase = "loading" | "ready" | "error";

export default function SearchExperience({ q }: { q: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [stage, setStage] = useState<SearchStageEvent | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [viewMode, setViewMode] = useState<"article" | "references">("article");
  const [followUp, setFollowUp] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const doneRef = useRef(false);

  // Behavior telemetry: time-on-result, scroll depth, citation clicks —
  // flushed via sendBeacon on unmount/visibility change/pagehide.
  const searchLogId = results?.searchLogId ?? null;
  useSearchBehaviorTracker(searchLogId);

  const onSearch = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) return;
      // A follow-up question is itself a behavior signal on the current search.
      if (searchLogId && trimmed !== q) {
        logBehavior({ searchLogId, followedUpQuery: trimmed });
      }
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [router, searchLogId, q],
  );

  // Vedabase citation clicks → citation_clicks table. One delegated listener
  // covers every ↗ link (hero cards, essay, context strip, Dig Deeper).
  useEffect(() => {
    if (!searchLogId) return;
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.('a[href*="vedabase.io"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const all = Array.from(document.querySelectorAll('a[href*="vedabase.io"]'));
      logCitationClick({
        searchLogId,
        citationRef: anchor.getAttribute("href"),
        clickPosition: all.indexOf(anchor) + 1 || null,
      });
    };
    document.addEventListener("click", onClick, { passive: true });
    return () => document.removeEventListener("click", onClick);
  }, [searchLogId]);

  useEffect(() => {
    doneRef.current = false;
    setPhase("loading");
    setStage(null);
    setResults(null);
    setViewMode("article");
    window.scrollTo({ top: 0 });

    let es: EventSource | null = null;
    let settled = false;

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
    const fail = () => settle(() => setPhase("error"));

    const fallbackFetch = async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SearchResults & { error?: string };
        if (data.error) throw new Error(data.error);
        finish(data);
      } catch (err) {
        console.error("[search] fallback fetch failed:", err);
        fail();
      }
    };

    const timeout = setTimeout(() => {
      console.error(`[search] no answer within ${TIMEOUT_MS / 1000}s`);
      fail();
    }, TIMEOUT_MS);

    if (typeof EventSource !== "undefined") {
      es = new EventSource(`/api/search?q=${encodeURIComponent(q)}&stream=1`);
      let sawEvent = false;
      es.addEventListener("stage", (e) => {
        sawEvent = true;
        try { setStage(JSON.parse((e as MessageEvent).data)); } catch { /* malformed frame */ }
      });
      es.addEventListener("result", (e) => {
        try { finish(JSON.parse((e as MessageEvent).data)); } catch { fail(); }
      });
      es.addEventListener("failure", () => fail());
      es.onerror = () => {
        // Network hiccup or SSE unsupported by an intermediary — one plain fetch,
        // which also serves the no-EventSource path below.
        if (settled) return;
        es?.close();
        console.warn(`[search] SSE ${sawEvent ? "dropped mid-stream" : "unavailable"} — falling back to plain fetch`);
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
  }, [q, retryNonce]);

  const answered = phase === "ready" && !!results;
  const ans = answered ? { op: 1, ty: "0px", rule: "160px" } : { op: 0, ty: "26px", rule: "0px" };

  const passageCount = results?.passages?.length || 0;
  const variants = (results?.queryVariants || []).slice(0, 6);

  const submitFollowUp = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(followUp);
  };

  return (
    <div>
      <SiteHeader variant="solid" />

      {phase === "loading" && <SearchLoader q={q} stage={stage} done={doneRef.current} />}

      <main style={{ maxWidth: 780, margin: "0 auto", padding: "110px clamp(20px,5vw,40px) 80px" }}>
        {/* ═══════ ERROR CARD — honest, never sample verses ═══════ */}
        {phase === "error" && (
          <div style={{ maxWidth: 560, margin: "10vh auto 0", textAlign: "center", background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(32px,5vw,48px)", boxShadow: "0 2px 6px rgba(43,37,25,0.04), 0 16px 44px rgba(43,37,25,0.07)" }}>
            <p className="font-display" style={{ fontSize: "clamp(22px,3vw,28px)", fontWeight: 600, color: "#201B12", margin: 0 }}>The library didn&rsquo;t answer.</p>
            <p className="font-body" style={{ fontSize: 14.5, lineHeight: 1.7, color: "#6E6353", margin: "12px 0 24px" }}>
              Your question &ldquo;{q}&rdquo; reached the library, but no answer came back in time. Nothing is wrong with your question — please try again.
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

            {/* Meta chips — honest live counts */}
            {results.totalResults > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: "clamp(36px,6vh,54px)", opacity: ans.op, transition: "opacity 0.9s ease 0.4s" }}>
                {passageCount > 0 && (
                  <span className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "#6E6353", background: "rgba(107,87,201,0.07)", border: "1px solid #E8E0D2", borderRadius: 100, padding: "6px 14px" }}>
                    {passageCount} relevant {passageCount === 1 ? "passage" : "passages"} — every one shown
                  </span>
                )}
                <span className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "#9A8F7D" }}>Every word below the labels is his — verbatim.</span>
              </div>
            )}

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
