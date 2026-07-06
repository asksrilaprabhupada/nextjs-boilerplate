/**
 * 07-how-it-works-page.tsx — How It Works (client page body)
 *
 * A cinematic explainer: a masked title reveal, three large numbered steps
 * (Ask → Verify → Go deeper), an "under the hood" four-card pipeline
 * (Understand · Search · Rerank · Weave), and a full-bleed CTA. A faithful React
 * port of the "How It Works" Claude Design prototype.
 */
"use client";

import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useCinematicReveal } from "./04-use-cinematic-reveal";

const IMG_DISCIPLES = "/images/lockscreen/prabhupadaanddisciplessmiling.jpg";

const STEPS = [
  { key: "s1", num: "01", title: "Ask", body: "Type any spiritual, philosophical, or practical question. It understands your intent and searches across his books, lectures, and letters." },
  { key: "s2", num: "02", title: "Verify", body: "Read an answer built from Prabhupāda's actual words — every verse and purport citation links directly to Vedabase.io." },
  { key: "s3", num: "03", title: "Go deeper", body: "Open the original verse, read the full purport, and continue your study with related references across scriptures." },
];

const PIPELINE = [
  { label: "1 · Understand", body: "Your question becomes keywords, synonyms, and a meaning vector." },
  { label: "2 · Search", body: "Hybrid search runs over every book, lecture, and letter — meaning and keywords together." },
  { label: "3 · Rerank", body: "A relevance model reorders the results so the truest passages rise." },
  { label: "4 · Weave", body: "His passages are joined verbatim with neutral framing — never paraphrased." },
  { label: "5 · Verify", body: "Every quote is checksum-verified against the library before it renders." },
];

export default function HowItWorksPage() {
  const { rootRef, entered, rev } = useCinematicReveal({ revealDistance: 40 });
  const op = entered ? { k: 1, l: "0", subY: "0px" } : { k: 0, l: "110%", subY: "16px" };

  const stepRev = (last: boolean, r: { op: number; ty: string }): React.CSSProperties => ({
    display: "grid", gridTemplateColumns: "minmax(80px, 140px) 1fr", gap: "clamp(18px,4vw,56px)", alignItems: "start",
    padding: "clamp(36px,6vh,64px) 0", borderTop: "1px solid #E8E0D2", borderBottom: last ? "1px solid #E8E0D2" : undefined,
    opacity: r.op, transform: `translateY(${r.ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)",
  });

  return (
    <div ref={rootRef}>
      <SiteHeader variant="overlay" />

      {/* Opening */}
      <section style={{ minHeight: "70vh", display: "flex", flexDirection: "column", justifyContent: "flex-end", maxWidth: 1280, margin: "0 auto", padding: "140px clamp(24px,6vw,100px) clamp(50px,8vh,90px)", width: "100%" }}>
        <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#6B57C9", marginBottom: 22, opacity: op.k, transition: "opacity 1s ease 0.15s" }}>How it works</p>
        <div style={{ overflow: "hidden", padding: "4px 0" }}>
          <h1 className="font-display" style={{ fontSize: "clamp(40px, 7.5vw, 104px)", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.04, color: "#201B12", maxWidth: 940, textWrap: "pretty", transform: `translateY(${op.l})`, transition: "transform 1.2s cubic-bezier(0.16,1,0.3,1) 0.3s" }}>Three steps to <span style={{ fontStyle: "italic", background: "linear-gradient(120deg, #C9A24B, #6B57C9)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>his answer</span></h1>
        </div>
        <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.75, color: "#6E6353", maxWidth: "52ch", textWrap: "balance", marginTop: 26, opacity: op.k, transform: `translateY(${op.subY})`, transition: "opacity 1s ease 0.7s, transform 1s cubic-bezier(0.16,1,0.3,1) 0.7s" }}>You ask in plain language. The system finds his exact words. You verify every source yourself.</p>
      </section>

      {/* Steps */}
      <section style={{ maxWidth: 1080, margin: "0 auto", padding: "0 clamp(24px,6vw,100px) clamp(70px,10vh,130px)", width: "100%", position: "relative" }}>
        {STEPS.map((s, i) => (
          <div key={s.key} data-creveal={s.key} style={stepRev(i === STEPS.length - 1, rev(s.key))}>
            <span className="font-display" style={{ fontSize: "clamp(56px,8vw,120px)", fontWeight: 500, color: "rgba(201,162,75,0.85)", lineHeight: 0.9, letterSpacing: "-0.03em" }}>{s.num}</span>
            <div>
              <h2 className="font-display" style={{ fontSize: "clamp(28px,4vw,52px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", lineHeight: 1.1, marginBottom: 14 }}>{s.title}</h2>
              <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.8, color: "#6E6353", maxWidth: "58ch" }}>{s.body}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Under the hood */}
      <section data-creveal="pipe" style={{ maxWidth: 1080, margin: "0 auto", padding: "0 clamp(24px,6vw,100px) clamp(80px,12vh,140px)", width: "100%", opacity: rev("pipe").op, transform: `translateY(${rev("pipe").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 14 }}>
          <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>Under the hood</p>
          <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
        </div>
        <h2 className="font-display" style={{ fontSize: "clamp(26px,3.4vw,44px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", lineHeight: 1.12, marginBottom: "clamp(26px,4vh,38px)", textWrap: "balance" }}>What happens under the hood</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
          {PIPELINE.map((c) => (
            <div key={c.label} className="cine-hood-card" style={{ background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 16, padding: "22px 20px", transition: "all 0.3s ease" }}>
              <p className="font-body" style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "#C9A24B", marginBottom: 8 }}>{c.label}</p>
              <p className="font-body" style={{ fontSize: 14, lineHeight: 1.65, color: "#6E6353" }}>{c.body}</p>
            </div>
          ))}
        </div>
        <p className="font-display" style={{ fontSize: "clamp(18px,2.2vw,24px)", fontStyle: "italic", color: "#6E6353", marginTop: "clamp(28px,4vh,40px)", maxWidth: 640 }}>The AI never writes philosophy. It finds, orders, and presents — <span style={{ color: "#51409A" }}>the words remain his.</span></p>
      </section>

      {/* CTA */}
      <section style={{ position: "relative", minHeight: "clamp(400px, 64vh, 620px)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url('${IMG_DISCIPLES}')`, backgroundSize: "cover", backgroundPosition: "center 28%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(250,247,241,0.55) 24%, rgba(250,247,241,0.30) 55%, rgba(250,247,241,0.88) 100%)" }} />
        <div data-creveal="cta" style={{ position: "relative", zIndex: 1, textAlign: "center", padding: "80px 24px", opacity: rev("cta").op, transform: `translateY(${rev("cta").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
          <h2 className="font-display" style={{ fontSize: "clamp(32px,4.8vw,62px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#201B12", marginBottom: 16, textWrap: "balance" }}>Ask your first question</h2>
          <Link href="/?ask=1" className="cine-cta-btn font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", borderRadius: 100, padding: "15px 38px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", boxShadow: "0 10px 34px rgba(107,87,201,0.30)", transition: "all 0.45s cubic-bezier(0.16,1,0.3,1)", marginTop: 12 }}><span>Search the books</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
