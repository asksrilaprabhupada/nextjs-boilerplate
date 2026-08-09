/**
 * 06-features-page.tsx — Features (client page body) — v2
 *
 * Three core features, each shown as a live vignette of the real interface
 * rather than another paragraph: a search bar typing a question, a verse
 * passage with its citation chip, and a row of source chips with the context
 * strip. Everything else — the supporting capabilities — sits quietly in a
 * four-card grid below.
 *
 * Two things the earlier version got wrong are fixed here: the page opens with
 * content in the first viewport (no 74vh void), and the small Vṛndāvana scan
 * is rendered at its honest card size against a blurred backdrop instead of
 * being stretched full-bleed.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useCinematicReveal } from "./04-use-cinematic-reveal";

const GITHUB_URL = "https://github.com/asksrilaprabhupada/nextjs-boilerplate";
const EASE = "cubic-bezier(0.16,1,0.3,1)";
const VIGNETTE_QUERY = "How do I control my restless mind?";

const vignetteCard: React.CSSProperties = {
  background: "linear-gradient(160deg, #FEFCF8, #F5F0E4)", border: "1px solid #E8E0D2", borderRadius: 20,
  padding: "clamp(24px,3vw,40px)", boxShadow: "0 2px 6px rgba(43,37,25,0.04), 0 20px 50px rgba(43,37,25,0.08)",
};
const numeral: React.CSSProperties = { fontSize: "clamp(22px,2.4vw,30px)", fontWeight: 500, color: "#C9A24B" };
const featureH2: React.CSSProperties = {
  margin: "10px 0 14px", fontSize: "clamp(28px,3.6vw,48px)", fontWeight: 600, letterSpacing: "-0.02em",
  color: "#201B12", lineHeight: 1.12, textWrap: "pretty",
};
const featureBody: React.CSSProperties = {
  margin: 0, fontSize: "clamp(15px,1.6vw,17px)", lineHeight: 1.75, color: "#6E6353", maxWidth: "52ch",
};
const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.76rem", fontWeight: 600,
  color: "#51409A", background: "#ECE8F9", borderRadius: 9999, padding: "4px 11px",
};
const dot = (color: string): React.CSSProperties => ({ width: 6, height: 6, borderRadius: "50%", background: color });

const ALSO = [
  { title: "The whole library", body: "Gītā, Bhāgavatam, Caitanya-caritāmṛta and 33 more titles, plus lectures and letters — 244,000+ passages searched together." },
  { title: "Complete purports", body: "His full commentary for every verse, folded neatly under its translation — expand in place, read as much as you need." },
  { title: "Dig deeper", body: "Nothing is removed — every further passage the search found waits in one quiet drawer, filterable by source." },
];

export default function FeaturesPage({ deitiesImageUrl }: { deitiesImageUrl: string | null }) {
  const { rootRef, entered, rev } = useCinematicReveal({ revealDistance: 40 });
  const [typed, setTyped] = useState("");

  // The vignette types the question, holds it, then starts again.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(VIGNETTE_QUERY);
      return;
    }
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const type = () => {
      if (i <= VIGNETTE_QUERY.length) {
        setTyped(VIGNETTE_QUERY.slice(0, i));
        i += 1;
        timer = setTimeout(type, 55);
      } else {
        timer = setTimeout(() => { i = 0; type(); }, 5000);
      }
    };
    timer = setTimeout(type, 900);
    return () => clearTimeout(timer);
  }, []);

  const op = entered ? { k: 1, line: "0", subY: "0px" } : { k: 0, line: "110%", subY: "16px" };
  const row = (key: string): React.CSSProperties => ({
    display: "grid", gap: "clamp(32px,5vw,72px)", alignItems: "center",
    opacity: rev(key).op, transform: `translateY(${rev(key).ty})`,
    transition: `opacity 0.9s ${EASE}, transform 0.9s ${EASE}`,
  });
  const section: React.CSSProperties = {
    maxWidth: 1280, margin: "0 auto", padding: "clamp(40px,7vh,80px) clamp(24px,6vw,100px)",
    width: "100%", boxSizing: "border-box",
  };

  return (
    <div ref={rootRef}>
      <SiteHeader variant="overlay" />

      {/* ── OPENING — content visible immediately ── */}
      <section style={{ maxWidth: 1280, margin: "0 auto", padding: "clamp(120px,18vh,180px) clamp(24px,6vw,100px) clamp(40px,6vh,64px)", width: "100%", boxSizing: "border-box" }}>
        <p className="font-body" style={{ margin: "0 0 20px", fontSize: 12, fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#6B57C9", opacity: op.k, transition: "opacity 1s ease 0.15s" }}>Features</p>
        <div style={{ overflow: "hidden", padding: "4px 0" }}>
          <h1 className="font-display" style={{ margin: 0, fontSize: "clamp(38px, 6.5vw, 92px)", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.04, color: "#201B12", maxWidth: 900, textWrap: "pretty", transform: `translateY(${op.line})`, transition: `transform 1.2s ${EASE} 0.3s` }}>
            Everything serves <span style={{ fontStyle: "italic", background: "linear-gradient(120deg, #C9A24B, #6B57C9)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>his words</span>
          </h1>
        </div>
        <p className="font-body" style={{ margin: "22px 0 0", fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.75, color: "#6E6353", maxWidth: "56ch", opacity: op.k, transform: `translateY(${op.subY})`, transition: `opacity 1s ease 0.6s, transform 1s ${EASE} 0.6s` }}>
          Three things matter: you ask naturally, the answer is verbatim, and every line can be verified. Here is what that looks like.
        </p>
      </section>

      {/* ── CORE 1 — ask in your own words ── */}
      <section data-creveal="c1" style={section}>
        <div className="cine-feature-row" style={{ ...row("c1"), gridTemplateColumns: "1fr 1.1fr" }}>
          <div data-copy>
            <span className="font-display" style={numeral}>01</span>
            <h2 className="font-display" style={featureH2}>Ask in your own words</h2>
            <p className="font-body" style={featureBody}>Any question, in natural language. The search understands intent and finds matching passages across all 36 books, 3,700 lectures, and 6,500 letters at once.</p>
          </div>
          <div data-vignette aria-hidden style={vignetteCard}>
            <div style={{ position: "relative", borderRadius: 16, padding: 1.5, background: "linear-gradient(135deg, rgba(107,87,201,0.5), rgba(201,162,75,0.32))", boxShadow: "0 8px 30px rgba(107,87,201,0.10)" }}>
              <div className="font-body" style={{ display: "flex", alignItems: "center", padding: "16px 60px 16px 20px", borderRadius: 14, background: "#FEFCF8", fontSize: 15, color: "#2B2519", whiteSpace: "nowrap", overflow: "hidden" }}>
                {typed}
                <span style={{ display: "inline-block", width: 2, height: "1.15em", background: "#6B57C9", marginLeft: 2, animation: "typewriterBlink 0.8s step-end infinite" }} />
              </div>
              <div style={{ position: "absolute", right: 8, top: 8, width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFFFFF" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <span className="font-body" style={{ fontSize: 12, padding: "6px 13px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", color: "#6E6353" }}>in my own words</span>
              <span className="font-body" style={{ fontSize: 12, padding: "6px 13px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", color: "#6E6353" }}>Krsna, Krishna, Kṛṣṇa — all work</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── CORE 2 — verbatim answers ── */}
      <section data-creveal="c2" style={section}>
        <div className="cine-feature-row" style={{ ...row("c2"), gridTemplateColumns: "1.1fr 1fr" }}>
          <div data-vignette aria-hidden style={{ ...vignetteCard, order: 1 }}>
            <p className="font-body" style={{ margin: "0 0 10px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: "#9A8F7D" }}>Verse translation · Bhagavad-gītā As It Is · his words</p>
            <p className="font-display" style={{ margin: 0, fontSize: "clamp(17px,1.9vw,21px)", lineHeight: 1.45, color: "#201B12" }}>
              <mark style={{ color: "inherit", backgroundImage: "linear-gradient(90deg, transparent 0%, rgba(139,110,224,0.16) 9%, rgba(201,162,75,0.14) 91%, transparent 100%)", backgroundRepeat: "no-repeat", backgroundSize: "100% 76%", backgroundPosition: "left center", borderRadius: 7, padding: "0.04em 0.32em", WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone" }}>
                For one who has conquered the mind, the mind is the best of friends.
              </mark>
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
              <span className="font-body" style={chip}><span style={dot("#6B57C9")} />Bg. 6.6</span>
              <span className="font-body" style={{ fontSize: "0.76rem", fontWeight: 500, color: "#6E6353" }}>Copy with reference</span>
            </div>
          </div>
          <div data-copy style={{ order: 2 }}>
            <span className="font-display" style={numeral}>02</span>
            <h2 className="font-display" style={featureH2}>Answers woven from his actual words</h2>
            <p className="font-body" style={featureBody}>&ldquo;Lord Kṛṣṇa says…&rdquo; for translations, &ldquo;Prabhupāda explains…&rdquo; for purports — never AI-generated philosophy. Every rendered quote is checksum-verified against the library before you see it.</p>
          </div>
        </div>
      </section>

      {/* ── CORE 3 — verify everything ── */}
      <section data-creveal="c3" style={section}>
        <div className="cine-feature-row" style={{ ...row("c3"), gridTemplateColumns: "1fr 1.1fr" }}>
          <div data-copy>
            <span className="font-display" style={numeral}>03</span>
            <h2 className="font-display" style={featureH2}>Verify every line yourself</h2>
            <p className="font-body" style={featureBody}>Every citation links to Vedabase.io — full verse, synonyms, complete purport. Context on tap shows the verses before and after, so nothing arrives stripped of its surroundings.</p>
          </div>
          <div data-vignette aria-hidden style={{ ...vignetteCard, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <span className="font-body" style={chip}><span style={dot("#6B57C9")} />Bg. 2.20 ↗</span>
              <span className="font-body" style={chip}><span style={dot("#C9A24B")} />Lecture · 1972 · Tokyo ↗</span>
              <span className="font-body" style={chip}><span style={dot("#8AA48F")} />Letter · 1970 ↗</span>
            </div>
            <div style={{ marginLeft: 14, padding: "12px 16px", borderLeft: "2px solid #E8E0D2", opacity: 0.85 }}>
              <p className="font-body" style={{ margin: 0, fontSize: "0.85rem", lineHeight: 1.6, color: "#6E6353" }}>
                <span style={{ fontSize: "0.74rem", fontWeight: 600, color: "#9A8F7D" }}>Just before this, it is asked —</span>{" "}
                <span style={{ fontStyle: "italic" }}>&ldquo;…to subdue it, I think, is more difficult than controlling the wind.&rdquo;</span>{" "}
                <span style={{ fontSize: "0.74rem", fontWeight: 600, color: "#51409A", whiteSpace: "nowrap" }}>Bg. 6.34</span>
              </p>
            </div>
            <p className="font-body" style={{ margin: 0, fontSize: 12, color: "#9A8F7D" }}>Every chip opens the source. Nothing asks to be trusted.</p>
          </div>
        </div>
      </section>

      {/* ── AND QUIETLY — supporting grid ── */}
      <section data-creveal="also" style={{ maxWidth: 1280, margin: "0 auto", padding: "clamp(50px,8vh,100px) clamp(24px,6vw,100px)", width: "100%", boxSizing: "border-box", opacity: rev("also").op, transform: `translateY(${rev("also").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: "clamp(30px,4vh,44px)" }}>
          <p className="font-body" style={{ margin: 0, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>And quietly</p>
          <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
          {ALSO.map((a) => (
            <div key={a.title} className="cine-hood-card" style={{ background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 16, padding: "24px 22px", transition: "all 0.3s ease" }}>
              <p className="font-display" style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: "#201B12" }}>{a.title}</p>
              <p className="font-body" style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: "#6E6353" }}>{a.body}</p>
            </div>
          ))}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="cine-hood-card" style={{ textDecoration: "none", background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 16, padding: "24px 22px", transition: "all 0.3s ease", display: "block" }}>
            <p className="font-display" style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: "#201B12" }}>Open source ↗</p>
            <p className="font-body" style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: "#6E6353" }}>Next.js, TypeScript, Supabase. Inspect it, contribute, or self-host — the library belongs to everyone.</p>
          </a>
        </div>
      </section>

      {/* ── INTERLUDE — the photo kept at its honest size ── */}
      <section data-creveal="inter" style={{ position: "relative", overflow: "hidden", background: "#16120C", padding: "clamp(60px,10vh,110px) clamp(24px,6vw,100px)" }}>
        {deitiesImageUrl && <div aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: `url('${deitiesImageUrl}')`, backgroundSize: "cover", backgroundPosition: "center 25%", filter: "blur(34px) brightness(0.5) saturate(1.05)", transform: "scale(1.15)" }} />}
        <div aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(90% 80% at 50% 50%, rgba(22,18,12,0.10), rgba(22,18,12,0.72))" }} />
        <div className="cine-feature-row" style={{ position: "relative", zIndex: 1, maxWidth: 1080, margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(220px, 380px) 1fr", gap: "clamp(28px,5vw,64px)", alignItems: "center", opacity: rev("inter").op, transform: `translateY(${rev("inter").ty})`, transition: `opacity 1.1s ${EASE}, transform 1.1s ${EASE}` }}>
          <figure data-vignette style={{ margin: 0 }}>
            <div style={{ overflow: "hidden", borderRadius: 16, boxShadow: "0 24px 70px rgba(0,0,0,0.4)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {deitiesImageUrl && <img src={deitiesImageUrl} alt="Śrīla Prabhupāda before the Kṛṣṇa-Balarāma Deities in Vṛndāvana" loading="lazy" style={{ width: "100%", display: "block" }} />}
            </div>
            <figcaption className="font-body" style={{ marginTop: 10, fontSize: 11, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,248,232,0.55)" }}>Before the Kṛṣṇa-Balarāma Deities, Vṛndāvana</figcaption>
          </figure>
          <div data-copy>
            <div aria-hidden style={{ width: 56, height: 1, background: "rgba(201,162,75,0.9)", marginBottom: 20 }} />
            <p className="font-display" style={{ margin: 0, fontSize: "clamp(1.4rem, 3vw, 2.4rem)", fontStyle: "italic", fontWeight: 500, color: "#FFF8E8", lineHeight: 1.35, textWrap: "pretty" }}>Every feature serves one purpose: his words, found faithfully.</p>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section data-creveal="cta" style={{ padding: "clamp(70px,12vh,130px) clamp(24px,6vw,100px)", textAlign: "center", opacity: rev("cta").op, transform: `translateY(${rev("cta").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
        <h2 className="font-display" style={{ margin: "0 0 16px", fontSize: "clamp(30px,4.4vw,58px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#201B12", textWrap: "balance" }}>See it in motion</h2>
        <p className="font-body" style={{ margin: "0 auto 30px", fontSize: "clamp(15px,1.7vw,17px)", lineHeight: 1.7, color: "#6E6353", maxWidth: 460 }}>Ask a question and watch the answer weave itself from his books.</p>
        <Link href="/?entrance=0" className="cine-cta-btn font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", borderRadius: 100, padding: "15px 38px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", boxShadow: "0 10px 34px rgba(107,87,201,0.30)", transition: `all 0.45s ${EASE}` }}>
          <span>Try the search</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </Link>
      </section>

      <SiteFooter />
    </div>
  );
}
