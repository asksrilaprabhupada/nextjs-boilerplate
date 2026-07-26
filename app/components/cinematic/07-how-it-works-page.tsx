/**
 * 07-how-it-works-page.tsx — How It Works (client page body) — v2
 *
 * A cinematic explainer: three large numbered steps (Ask → Verify → Go
 * deeper), then "under the hood" — the five real pipeline stages
 * (Understand · Search · Rerank · Weave · Verify) drawn as one connected
 * line, the same five the search loader ticks through — and a closing CTA
 * band that parallaxes gently behind the paper.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useCinematicReveal } from "./04-use-cinematic-reveal";

const DISCIPLES = "/images/lockscreen/prabhupadaanddisciplessmiling.jpg";
const EASE = "cubic-bezier(0.16,1,0.3,1)";

const STEPS = [
  {
    key: "s1", num: "01", title: "Ask",
    body: "Type any spiritual, philosophical, or practical question. It understands your intent and searches across his books, lectures, and letters.",
    detail: "Spelling never blocks you — Krsna, Krishna, and Kṛṣṇa all find him.",
    last: false,
  },
  {
    key: "s2", num: "02", title: "Verify",
    body: "Read an answer built from Prabhupāda's actual words — every verse and purport citation links directly to Vedabase.io.",
    detail: "Every quote carries its reference chip. Tap it, read the source.",
    last: false,
  },
  {
    key: "s3", num: "03", title: "Go deeper",
    body: "Open the original verse, read the full purport, and continue your study with related references across scriptures.",
    detail: "The Dig Deeper drawer keeps every further passage the search found.",
    last: true,
  },
];

const PIPELINE = [
  { label: "1 · Understand", body: "Your question becomes keywords, synonyms, and a meaning vector.", dot: "#C9A24B" },
  { label: "2 · Search", body: "Hybrid search runs over every book, lecture, and letter — meaning and keywords together.", dot: "#BD9857" },
  { label: "3 · Rerank", body: "A relevance model reorders the results so the truest passages rise.", dot: "#A78163" },
  { label: "4 · Weave", body: "His passages are joined verbatim with neutral framing — never paraphrased.", dot: "#8A6C96" },
  { label: "5 · Verify", body: "Every quote is checksum-verified against the library before it renders.", dot: "#6B57C9" },
];

export default function HowItWorksPage() {
  const { rootRef, entered, rev } = useCinematicReveal({ revealDistance: 40 });
  const parallaxRef = useRef<HTMLDivElement>(null);

  // The closing band drifts a little slower than the page.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const loop = () => {
      const el = parallaxRef.current;
      const parent = el?.parentElement;
      if (el && parent) {
        const r = parent.getBoundingClientRect();
        const offset = -(r.top + r.height / 2 - window.innerHeight / 2) * 0.1;
        el.style.transform = `translateY(${offset.toFixed(1)}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const op = entered ? { k: 1, line: "0", subY: "0px" } : { k: 0, line: "110%", subY: "16px" };

  return (
    <div ref={rootRef}>
      <SiteHeader variant="overlay" />

      {/* ── OPENING ── */}
      <section style={{ maxWidth: 1280, margin: "0 auto", padding: "clamp(120px,18vh,180px) clamp(24px,6vw,100px) clamp(40px,6vh,64px)", width: "100%", boxSizing: "border-box" }}>
        <p className="font-body" style={{ margin: "0 0 20px", fontSize: 12, fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#6B57C9", opacity: op.k, transition: "opacity 1s ease 0.15s" }}>How it works</p>
        <div style={{ overflow: "hidden", padding: "4px 0" }}>
          <h1 className="font-display" style={{ margin: 0, fontSize: "clamp(38px, 6.5vw, 92px)", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.04, color: "#201B12", maxWidth: 940, textWrap: "pretty", transform: `translateY(${op.line})`, transition: `transform 1.2s ${EASE} 0.3s` }}>
            Three steps to <span style={{ fontStyle: "italic", background: "linear-gradient(120deg, #C9A24B, #6B57C9)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>his answer</span>
          </h1>
        </div>
        <p className="font-body" style={{ margin: "22px 0 0", fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.75, color: "#6E6353", maxWidth: "52ch", textWrap: "balance", opacity: op.k, transform: `translateY(${op.subY})`, transition: `opacity 1s ease 0.6s, transform 1s ${EASE} 0.6s` }}>
          You ask in plain language. The system finds his exact words. You verify every source yourself.
        </p>
      </section>

      {/* ── THE THREE STEPS ── */}
      <section style={{ maxWidth: 1080, margin: "0 auto", padding: "clamp(30px,5vh,60px) clamp(24px,6vw,100px) clamp(60px,9vh,110px)", width: "100%", boxSizing: "border-box", position: "relative" }}>
        {STEPS.map((st) => (
          <div key={st.key} data-creveal={st.key} style={{ display: "grid", gridTemplateColumns: "minmax(80px, 140px) 1fr", gap: "clamp(18px,4vw,56px)", alignItems: "start", padding: "clamp(32px,5vh,56px) 0", borderTop: "1px solid #E8E0D2", borderBottom: st.last ? "1px solid #E8E0D2" : "none", opacity: rev(st.key).op, transform: `translateY(${rev(st.key).ty})`, transition: `opacity 0.9s ${EASE}, transform 0.9s ${EASE}` }}>
            <span className="font-display" style={{ fontSize: "clamp(56px,7vw,110px)", fontWeight: 500, color: "rgba(201,162,75,0.85)", lineHeight: 0.9, letterSpacing: "-0.03em" }}>{st.num}</span>
            <div>
              <h2 className="font-display" style={{ margin: "0 0 12px", fontSize: "clamp(28px,3.8vw,48px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", lineHeight: 1.1 }}>{st.title}</h2>
              <p className="font-body" style={{ margin: "0 0 16px", fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.8, color: "#6E6353", maxWidth: "58ch" }}>{st.body}</p>
              <p className="font-body" style={{ margin: 0, fontSize: 12.5, fontWeight: 500, color: "#9A8F7D" }}><span style={{ color: "#C9A24B" }}>◆</span>&nbsp; {st.detail}</p>
            </div>
          </div>
        ))}
      </section>

      {/* ── UNDER THE HOOD — the real pipeline as one connected line ── */}
      <section data-creveal="pipe" style={{ maxWidth: 1080, margin: "0 auto", padding: "0 clamp(24px,6vw,100px) clamp(80px,12vh,140px)", width: "100%", boxSizing: "border-box", opacity: rev("pipe").op, transform: `translateY(${rev("pipe").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 14 }}>
          <p className="font-body" style={{ margin: 0, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>Under the hood</p>
          <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
        </div>
        <h2 className="font-display" style={{ margin: "0 0 10px", fontSize: "clamp(26px,3.4vw,44px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", lineHeight: 1.12, textWrap: "balance" }}>Five quiet moments between your question and his answer</h2>
        <p className="font-body" style={{ margin: "0 0 clamp(30px,5vh,44px)", fontSize: 14, color: "#9A8F7D" }}>The same five stages you watch on the loading screen.</p>

        <div style={{ position: "relative" }}>
          <div aria-hidden style={{ position: "absolute", top: 5, left: 8, right: 8, height: 1, background: "linear-gradient(90deg, #C9A24B, #6B57C9)" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
            {PIPELINE.map((p) => (
              <div key={p.label} style={{ position: "relative", paddingTop: 24 }}>
                <span aria-hidden style={{ position: "absolute", top: 0, left: 8, width: 11, height: 11, borderRadius: "50%", background: "#FAF7F1", border: `2px solid ${p.dot}`, boxSizing: "border-box" }} />
                <div className="cine-hood-card" style={{ background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 16, padding: "20px 18px", height: "100%", boxSizing: "border-box", transition: "all 0.3s ease" }}>
                  <p className="font-body" style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "#C9A24B" }}>{p.label}</p>
                  <p className="font-body" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "#6E6353" }}>{p.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="font-display" style={{ margin: "clamp(28px,4vh,40px) 0 0", fontSize: "clamp(18px,2.2vw,24px)", fontStyle: "italic", color: "#6E6353", maxWidth: 640 }}>
          AI-assisted retrieval that finds and orders his words — <span style={{ color: "#51409A" }}>it never writes philosophy.</span>
        </p>
      </section>

      {/* ── CTA BAND ── */}
      <section style={{ position: "relative", minHeight: "clamp(400px, 64vh, 620px)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div ref={parallaxRef} aria-hidden style={{ position: "absolute", inset: "-12% 0", backgroundImage: `url('${DISCIPLES}')`, backgroundSize: "cover", backgroundPosition: "center 28%", willChange: "transform" }} />
        <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(250,247,241,0.55) 24%, rgba(250,247,241,0.30) 55%, rgba(250,247,241,0.88) 100%)" }} />
        <div data-creveal="cta" style={{ position: "relative", zIndex: 1, textAlign: "center", padding: "80px 24px", opacity: rev("cta").op, transform: `translateY(${rev("cta").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
          <h2 className="font-display" style={{ margin: "0 0 16px", fontSize: "clamp(32px,4.8vw,62px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#201B12", textWrap: "balance" }}>Ask your first question</h2>
          <Link href="/?entrance=0" className="cine-cta-btn font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", borderRadius: 100, padding: "15px 38px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", boxShadow: "0 10px 34px rgba(107,87,201,0.30)", transition: `all 0.45s ${EASE}`, marginTop: 12 }}>
            <span>Search the books</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
