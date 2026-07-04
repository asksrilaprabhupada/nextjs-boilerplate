/**
 * 08-search-results-page.tsx — Search Results (client page body, woven answer)
 *
 * The destination of the main page's cinematic search moment. It opens with a
 * meditative aura/mandala loader, then reveals a woven answer: the question in
 * big serif, verbatim passage cards labelled TYPE · SOURCE · SPEAKER with
 * Vedabase links and copy-with-reference, a "Dig deeper" side drawer of overflow
 * sources, and a helpful/not-helpful vote. A faithful React port of the
 * "Search Results" Claude Design prototype.
 *
 * The four hero passages are the prototype's canned answer (a static mock). When
 * integrating, replace them — and the loader timing — with your real /api/search
 * response; the read of `?q=` already carries the user's question through.
 */
"use client";

import Link from "next/link";
import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import CinematicPageHeader from "./02-cinematic-page-header";

const DEFAULT_Q = "What is the purpose of human life?";
const LOAD_STATUSES = ["Listening…", "Searching the library…", "Weaving his words…"];
const MANDALA = Array.from({ length: 12 }, (_, i) => i * 30);

const DEEP_ITEMS = [
  { type: "Verse", ref: "Bhagavad-gītā 6.6", text: "For one who has conquered the mind, the mind is the best of friends; but for one who has failed to do so, his mind will remain the greatest enemy.", href: "https://vedabase.io/en/library/bg/6/6/" },
  { type: "Verse", ref: "Bhagavad-gītā 5.18", text: "The humble sages, by virtue of true knowledge, see with equal vision a learned and gentle brāhmaṇa, a cow, an elephant, a dog and a dog-eater.", href: "https://vedabase.io/en/library/bg/5/18/" },
  { type: "Verse", ref: "Bhagavad-gītā 2.56", text: "One who is not disturbed in mind even amidst the threefold miseries or elated when there is happiness, and who is free from attachment, fear and anger, is called a sage of steady mind.", href: "https://vedabase.io/en/library/bg/2/56/" },
  { type: "Verse", ref: "Bhagavad-gītā 13.28", text: "One who sees the Supersoul accompanying the individual soul in all bodies, and who understands that neither the soul nor the Supersoul within the destructible body is ever destroyed, actually sees.", href: "https://vedabase.io/en/library/bg/13/28/" },
  { type: "Verse", ref: "Bhagavad-gītā 3.21", text: "Whatever action a great man performs, common men follow. And whatever standards he sets by exemplary acts, all the world pursues.", href: "https://vedabase.io/en/library/bg/3/21/" },
];

const labelRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 10, rowGap: 2, fontSize: 11, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: "#9A8F7D" };
const verseText: CSSProperties = { fontStyle: "italic", fontWeight: 500, lineHeight: 1.55, color: "#2B2519", textWrap: "pretty" };
const sourceRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 20, paddingTop: 14, borderTop: "1px solid #F1EBDF" };
const chip: CSSProperties = { textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#6E6353", background: "transparent", border: "1px solid #E8E0D2", borderRadius: 100, padding: "7px 14px", cursor: "pointer", transition: "all 0.3s ease" };

export default function SearchResultsPage() {
  const [q, setQ] = useState(DEFAULT_Q);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaderOp, setLoaderOp] = useState(1);
  const [loadPhase, setLoadPhase] = useState(0);
  const [answered, setAnswered] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [deepOpen, setDeepOpen] = useState(false);
  const [copied1, setCopied1] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const loadIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);

  const playLoader = useCallback(() => {
    setLoading(true); setLoaderOp(1); setLoadPhase(0); setAnswered(false);
    let phase = 0;
    if (loadIvRef.current) clearInterval(loadIvRef.current);
    loadIvRef.current = setInterval(() => {
      phase += 1;
      if (phase >= 3) {
        if (loadIvRef.current) clearInterval(loadIvRef.current);
        setLoaderOp(0); setAnswered(true);
        const t = setTimeout(() => setLoading(false), 750);
        timersRef.current.push(t);
        return;
      }
      setLoadPhase(phase);
    }, 950);
  }, []);

  const observeReveals = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    ioRef.current?.disconnect();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const key = entry.target.getAttribute("data-creveal");
          if (key) setRevealed((s) => ({ ...s, [key]: true }));
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
    root.querySelectorAll("[data-creveal]").forEach((el) => io.observe(el));
    ioRef.current = io;
  }, []);

  useEffect(() => {
    let initial = DEFAULT_Q;
    try {
      const p = new URLSearchParams(window.location.search).get("q");
      if (p && p.trim()) initial = p.trim();
    } catch { /* ok */ }
    setQ(initial);
    setQuery(initial);

    playLoader();

    const setup = setTimeout(observeReveals, 600);
    timersRef.current.push(setup);

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDeepOpen(false); };
    window.addEventListener("keydown", onKey);

    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      if (loadIvRef.current) clearInterval(loadIvRef.current);
      ioRef.current?.disconnect();
      window.removeEventListener("keydown", onKey);
    };
  }, [playLoader, observeReveals]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setQ(query.trim());
    setRevealed({});
    window.scrollTo({ top: 0 });
    playLoader();
    // re-arm the reveal observer for the fresh answer
    const t = setTimeout(observeReveals, 600);
    timersRef.current.push(t);
  };

  const copyHero = () => {
    try { navigator.clipboard.writeText("“For the soul there is neither birth nor death at any time.” — Bhagavad-gītā 2.20, tr. A.C. Bhaktivedanta Swami Prabhupāda"); } catch { /* ok */ }
    setCopied1(true);
    const t = setTimeout(() => setCopied1(false), 1600);
    timersRef.current.push(t);
  };

  const rev = (k: string) => (revealed[k] ? { op: 1, ty: "0px" } : { op: 0, ty: "36px" });
  const ans = answered ? { op: 1, ty: "0px", rule: "160px" } : { op: 0, ty: "26px", rule: "0px" };

  return (
    <div ref={rootRef}>
      <CinematicPageHeader active="search" forceScrolled />

      {/* ═══════ MEDITATIVE LOADER ═══════ */}
      {loading && (
        <div style={{ position: "fixed", inset: 0, zIndex: 800, background: "rgba(250,247,241,0.97)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, opacity: loaderOp, transition: "opacity 0.7s ease" }}>
          <div style={{ position: "relative", width: "min(70vw, 320px)", height: "min(70vw, 320px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div aria-hidden style={{ position: "absolute", top: "50%", left: "50%", width: "130%", height: "130%", borderRadius: "50%", background: "radial-gradient(circle, rgba(139,110,224,0.26) 0%, rgba(201,162,75,0.12) 42%, transparent 70%)", filter: "blur(38px)", animation: "auraBreathe 4.5s ease-in-out infinite" }} />
            <svg viewBox="0 0 400 400" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.16, animation: "rotateMandala 60s linear infinite", color: "#6B57C9" }}>
              {MANDALA.map((deg, i) => (
                <g key={i} transform={`rotate(${deg} 200 200)`}><ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.6" /></g>
              ))}
              <circle cx="200" cy="200" r="70" fill="none" stroke="currentColor" strokeWidth="0.5" />
            </svg>
            <p className="font-display" style={{ fontSize: "clamp(17px, 2.4vw, 22px)", fontStyle: "italic", color: "#51409A", textAlign: "center", maxWidth: 240, position: "relative" }}>{LOAD_STATUSES[loadPhase]}</p>
          </div>
          <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 10, maxWidth: 460, textAlign: "center" }}>&ldquo;{q}&rdquo;</p>
        </div>
      )}

      <main style={{ maxWidth: 780, margin: "0 auto", padding: "120px clamp(20px,5vw,40px) 80px" }}>
        {/* Follow-up bar */}
        <form onSubmit={submit} style={{ position: "sticky", top: 68, zIndex: 60, marginBottom: "clamp(40px,7vh,64px)", opacity: ans.op, transition: "opacity 0.8s ease 0.1s" }}>
          <div style={{ position: "relative", borderRadius: 16, padding: 1.5, background: "linear-gradient(135deg, rgba(107,87,201,0.42), rgba(201,162,75,0.28))", boxShadow: "0 8px 30px rgba(43,37,25,0.10)" }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Ask a follow-up" placeholder="Ask a follow-up question…" className="font-body" style={{ width: "100%", display: "block", padding: "14px 108px 14px 20px", fontSize: 15, border: "none", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none" }} />
            <Link href="/?ask=1" aria-label="New search" title="New search" className="cine-newsearch" style={{ position: "absolute", right: 52, top: 8, width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#6E6353", textDecoration: "none", transition: "all 0.2s ease" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </Link>
            <button type="submit" aria-label="Search" className="cine-submit-btn" style={{ position: "absolute", right: 8, top: 8, width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        </form>

        {/* You asked */}
        <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color: "#6B57C9", marginBottom: 18, opacity: ans.op, transform: `translateY(${ans.ty})`, transition: "opacity 0.8s cubic-bezier(0.16,1,0.3,1) 0.05s, transform 0.8s cubic-bezier(0.16,1,0.3,1) 0.05s" }}>You asked</p>
        <h1 className="font-display" style={{ fontSize: "clamp(30px,4.6vw,54px)", fontWeight: 600, lineHeight: 1.12, letterSpacing: "-0.02em", color: "#201B12", textWrap: "pretty", opacity: ans.op, transform: `translateY(${ans.ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.15s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.15s" }}>{q}</h1>
        <div aria-hidden style={{ width: ans.rule, height: 1, background: "linear-gradient(90deg, #C9A24B, rgba(201,162,75,0))", margin: "26px 0", transition: "width 1.3s cubic-bezier(0.16,1,0.3,1) 0.5s" }} />

        {/* Meta */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: "clamp(36px,6vh,54px)", opacity: ans.op, transition: "opacity 0.9s ease 0.4s" }}>
          <span className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "#6E6353", background: "rgba(107,87,201,0.07)", border: "1px solid #E8E0D2", borderRadius: 100, padding: "6px 14px" }}>Woven from 4 passages</span>
          <span className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "#6E6353", background: "rgba(201,162,75,0.08)", border: "1px solid #E8E0D2", borderRadius: 100, padding: "6px 14px" }}>Bhagavad-gītā As It Is</span>
          <span className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "#9A8F7D" }}>Every word below the labels is his — verbatim.</span>
        </div>

        {/* Framing intro */}
        <p className="font-body" style={{ fontSize: "clamp(16px,1.8vw,18px)", lineHeight: 1.85, color: "#6B6151", maxWidth: "65ch", marginBottom: "clamp(32px,5vh,44px)", opacity: ans.op, transform: `translateY(${ans.ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.5s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.5s" }}>On this question, the Bhagavad-gītā speaks directly. Kṛṣṇa begins with what the self actually is — the eternal soul — and then describes the path and its promise. The passages below are presented exactly as Śrīla Prabhupāda translated them.</p>

        {/* HERO PASSAGE */}
        <article data-creveal="p1" style={{ position: "relative", background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(28px,4.5vw,48px)", marginBottom: 22, boxShadow: "0 2px 6px rgba(43,37,25,0.04), 0 16px 44px rgba(43,37,25,0.07)", opacity: rev("p1").op, transform: `translateY(${rev("p1").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
          <div aria-hidden style={{ position: "absolute", top: 0, left: "clamp(28px,4.5vw,48px)", right: "clamp(28px,4.5vw,48px)", height: 1, background: "linear-gradient(90deg, transparent, rgba(201,162,75,0.7), transparent)" }} />
          <div className="font-body" style={{ ...labelRow, marginBottom: 20 }}>
            <span>Verse</span><span aria-hidden>·</span><span>Bhagavad-gītā 2.20</span><span aria-hidden>·</span><span style={{ color: "#C9A24B" }}>Kṛṣṇa speaking</span>
          </div>
          <p className="font-display" style={{ ...verseText, fontSize: "clamp(1.35rem, 2.8vw, 1.9rem)", lineHeight: 1.5 }}>&ldquo;For the soul there is neither birth nor death at any time. He has not come into being, does not come into being, and will not come into being. He is unborn, eternal, ever-existing and primeval. He is not slain when the body is slain.&rdquo;</p>
          <div style={{ ...sourceRow, marginTop: 24, paddingTop: 16 }}>
            <a href="https://vedabase.io/en/library/bg/2/20/" target="_blank" rel="noopener noreferrer" className="cine-source-link font-body" style={chip}>Vedabase ↗</a>
            <button onClick={copyHero} className="cine-source-link font-body" style={chip}>{copied1 ? "Copied ✓" : "Copy with reference"}</button>
          </div>
        </article>

        {/* Framing bridge */}
        <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,17px)", lineHeight: 1.85, color: "#6B6151", maxWidth: "65ch", margin: "clamp(28px,4vh,38px) 0", opacity: rev("p1").op, transition: "opacity 1s ease 0.3s" }}>If the self is eternal, the human question becomes: what is worth pursuing? Kṛṣṇa answers that even a small step on this path is never lost —</p>

        {/* PASSAGE 2 */}
        <article data-creveal="p2" style={{ background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(24px,3.5vw,36px)", marginBottom: 22, boxShadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)", opacity: rev("p2").op, transform: `translateY(${rev("p2").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
          <div className="font-body" style={{ ...labelRow, marginBottom: 16 }}>
            <span>Verse</span><span aria-hidden>·</span><span>Bhagavad-gītā 2.40</span><span aria-hidden>·</span><span style={{ color: "#C9A24B" }}>Kṛṣṇa speaking</span>
          </div>
          <p className="font-display" style={{ ...verseText, fontSize: "clamp(1.15rem, 2.2vw, 1.5rem)" }}>&ldquo;In this endeavor there is no loss or diminution, and a little advancement on this path can protect one from the most dangerous type of fear.&rdquo;</p>
          <div style={sourceRow}>
            <a href="https://vedabase.io/en/library/bg/2/40/" target="_blank" rel="noopener noreferrer" className="cine-source-link font-body" style={chip}>Vedabase ↗</a>
          </div>
        </article>

        {/* PASSAGE 3 */}
        <article data-creveal="p3" style={{ background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(24px,3.5vw,36px)", marginBottom: 22, boxShadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)", opacity: rev("p3").op, transform: `translateY(${rev("p3").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
          <div className="font-body" style={{ ...labelRow, marginBottom: 16 }}>
            <span>Verse</span><span aria-hidden>·</span><span>Bhagavad-gītā 10.10</span><span aria-hidden>·</span><span style={{ color: "#C9A24B" }}>Kṛṣṇa speaking</span>
          </div>
          <p className="font-display" style={{ ...verseText, fontSize: "clamp(1.15rem, 2.2vw, 1.5rem)" }}>&ldquo;To those who are constantly devoted to serving Me with love, I give the understanding by which they can come to Me.&rdquo;</p>
          <div style={sourceRow}>
            <a href="https://vedabase.io/en/library/bg/10/10/" target="_blank" rel="noopener noreferrer" className="cine-source-link font-body" style={chip}>Vedabase ↗</a>
          </div>
        </article>

        {/* Framing bridge */}
        <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,17px)", lineHeight: 1.85, color: "#6B6151", maxWidth: "65ch", margin: "clamp(28px,4vh,38px) 0", opacity: rev("p3").op, transition: "opacity 1s ease 0.3s" }}>And in the Gītā&rsquo;s final chapter, the conclusion itself —</p>

        {/* PASSAGE 4 */}
        <article data-creveal="p4" style={{ background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(24px,3.5vw,36px)", marginBottom: 22, boxShadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)", opacity: rev("p4").op, transform: `translateY(${rev("p4").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
          <div className="font-body" style={{ ...labelRow, marginBottom: 16 }}>
            <span>Verse</span><span aria-hidden>·</span><span>Bhagavad-gītā 18.66</span><span aria-hidden>·</span><span style={{ color: "#C9A24B" }}>Kṛṣṇa speaking</span>
          </div>
          <p className="font-display" style={{ ...verseText, fontSize: "clamp(1.15rem, 2.2vw, 1.5rem)" }}>&ldquo;Abandon all varieties of religion and just surrender unto Me. I shall deliver you from all sinful reactions. Do not fear.&rdquo;</p>
          <div style={sourceRow}>
            <a href="https://vedabase.io/en/library/bg/18/66/" target="_blank" rel="noopener noreferrer" className="cine-source-link font-body" style={chip}>Vedabase ↗</a>
          </div>
        </article>

        {/* Dig deeper */}
        <div data-creveal="deep" style={{ marginTop: "clamp(36px,6vh,54px)", opacity: rev("deep").op, transform: `translateY(${rev("deep").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
          <button onClick={() => setDeepOpen(true)} className="cine-deep-btn" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, background: "linear-gradient(135deg, rgba(107,87,201,0.07), rgba(201,162,75,0.06))", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(20px,3vw,28px)", cursor: "pointer", transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)", textAlign: "left" }}>
            <span>
              <span className="font-display" style={{ display: "block", fontSize: "clamp(20px,2.4vw,26px)", fontWeight: 600, color: "#201B12" }}>Dig deeper</span>
              <span className="font-body" style={{ display: "block", fontSize: 13, color: "#6E6353", marginTop: 4 }}>142 more passages · lectures, purports, and letters on this question</span>
            </span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: "#6B57C9" }}><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>

        {/* Feedback */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: "clamp(40px,6vh,56px)", opacity: rev("deep").op, transition: "opacity 1s ease 0.3s" }}>
          <span className="font-body" style={{ fontSize: 13, color: "#9A8F7D" }}>Was this helpful?</span>
          <button onClick={() => setVote((v) => (v === "up" ? null : "up"))} aria-label="Helpful" className="cine-results-vote" style={{ width: 38, height: 38, borderRadius: "50%", border: `1px solid ${vote === "up" ? "#6B57C9" : "#E8E0D2"}`, background: vote === "up" ? "rgba(107,87,201,0.12)" : "#FEFCF8", color: vote === "up" ? "#51409A" : "#9A8F7D", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /></svg>
          </button>
          <button onClick={() => setVote((v) => (v === "down" ? null : "down"))} aria-label="Not helpful" className="cine-results-vote" style={{ width: 38, height: 38, borderRadius: "50%", border: `1px solid ${vote === "down" ? "#6B57C9" : "#E8E0D2"}`, background: vote === "down" ? "rgba(107,87,201,0.12)" : "#FEFCF8", color: vote === "down" ? "#51409A" : "#9A8F7D", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: "rotate(180deg)" }}><path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /></svg>
          </button>
        </div>
      </main>

      {/* ═══════ DIG DEEPER DRAWER ═══════ */}
      {deepOpen && (
        <div onClick={() => setDeepOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(32,27,18,0.25)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }} />
      )}
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 950, width: "min(92vw, 460px)", background: "#FAF7F1", borderLeft: "1px solid #E8E0D2", boxShadow: "-24px 0 80px rgba(32,27,18,0.18)", transform: `translateX(${deepOpen ? "0" : "105%"})`, transition: "transform 0.55s cubic-bezier(0.16,1,0.3,1)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "22px 24px", borderBottom: "1px solid #E8E0D2" }}>
          <div>
            <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#51409A" }}>Dig deeper</p>
            <p className="font-body" style={{ fontSize: 13, color: "#6E6353", marginTop: 3 }}>More of his words on this question</p>
          </div>
          <button onClick={() => setDeepOpen(false)} aria-label="Close" className="cine-drawer-close" style={{ width: 32, height: 32, borderRadius: 9, border: "1px solid #E8E0D2", background: "#FEFCF8", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s ease" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px 30px", display: "flex", flexDirection: "column", gap: 12 }}>
          {DEEP_ITEMS.map((d) => (
            <a key={d.ref} href={d.href} target="_blank" rel="noopener noreferrer" className="cine-deep-item" style={{ textDecoration: "none", display: "block", background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 14, padding: "16px 18px", transition: "all 0.3s cubic-bezier(0.2,0,0,1)" }}>
              <div className="font-body" style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: "#9A8F7D", marginBottom: 8 }}>
                <span>{d.type}</span><span aria-hidden>·</span><span>{d.ref}</span>
              </div>
              <p className="font-display" style={{ fontSize: 16.5, fontStyle: "italic", lineHeight: 1.5, color: "#2B2519" }}>&ldquo;{d.text}&rdquo;</p>
            </a>
          ))}
          <p className="font-body" style={{ fontSize: 12.5, color: "#9A8F7D", textAlign: "center", padding: "12px 0 4px" }}>Prototype shows 5 of 142 passages — the live site returns them all.</p>
        </div>
      </div>
    </div>
  );
}
