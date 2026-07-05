/**
 * 06-features-page.tsx — Features (client page body)
 *
 * An editorial, cinematic treatment of the product's features: a masked title
 * reveal, six numbered feature rows that fade up as they enter the viewport, a
 * static full-bleed verse interlude, and a CTA back to search. A faithful React
 * port of the "Features" Claude Design prototype.
 */
"use client";

import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useCinematicReveal } from "./04-use-cinematic-reveal";

const IMG_DEITIES = "/images/lockscreen/Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg";

const FEATURES = [
  { key: "f1", num: "01", title: "Ask in your own words", description: "Ask any question in natural language — it finds the matching passages across his books, lectures, and letters." },
  { key: "f2", num: "02", title: "36 books, 3,700 lectures, 6,500 letters", description: "Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, plus 33 more books, thousands of recorded lectures, and personal letters — all searchable from one interface." },
  { key: "f3", num: "03", title: "Prabhupāda's purports", description: "Access complete commentary and purports by His Divine Grace for every verse — with direct links to Vedabase.io for full context." },
  { key: "f4", num: "04", title: "Narrative answers", description: "Answers weave Prabhupāda's actual words into flowing answers — “Lord Kṛṣṇa says…” for translations, “Prabhupāda explains…” for purports. Never AI-generated philosophy." },
  { key: "f5", num: "05", title: "Citation links", description: "Every verse reference links directly to Vedabase.io. Click any citation to read the full verse, synonyms, and complete purport." },
  { key: "f6", num: "06", title: "Open source", description: "Built with Next.js, TypeScript, Supabase, and Claude AI. Fully open source — inspect, contribute, or self-host." },
];

export default function FeaturesPage() {
  const { rootRef, entered, rev } = useCinematicReveal({ revealDistance: 40 });
  const op = entered ? { k: 1, l: "0", subY: "0px" } : { k: 0, l: "110%", subY: "16px" };

  return (
    <div ref={rootRef}>
      <SiteHeader variant="overlay" />

      {/* Opening */}
      <section style={{ minHeight: "74vh", display: "flex", flexDirection: "column", justifyContent: "flex-end", maxWidth: 1280, margin: "0 auto", padding: "140px clamp(24px,6vw,100px) clamp(50px,8vh,90px)", width: "100%" }}>
        <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#6B57C9", marginBottom: 22, opacity: op.k, transition: "opacity 1s ease 0.15s" }}>Features</p>
        <div style={{ overflow: "hidden", padding: "4px 0" }}>
          <h1 className="font-display" style={{ fontSize: "clamp(40px, 7.5vw, 104px)", fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.04, color: "#201B12", maxWidth: 900, textWrap: "pretty", transform: `translateY(${op.l})`, transition: "transform 1.2s cubic-bezier(0.16,1,0.3,1) 0.3s" }}>Everything you need to <span style={{ fontStyle: "italic", background: "linear-gradient(120deg, #C9A24B, #6B57C9)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>explore scripture</span></h1>
        </div>
        <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.75, color: "#6E6353", maxWidth: "56ch", marginTop: 26, opacity: op.k, transform: `translateY(${op.subY})`, transition: "opacity 1s ease 0.7s, transform 1s cubic-bezier(0.16,1,0.3,1) 0.7s" }}>Built for devotees, teachers, and seekers — every feature exists to bring you to his actual words faster.</p>
      </section>

      {/* Feature rows */}
      <section style={{ maxWidth: 1280, margin: "0 auto", padding: "0 clamp(24px,6vw,100px) clamp(70px,10vh,120px)", width: "100%" }}>
        {FEATURES.map((f) => {
          const r = rev(f.key);
          return (
            <div key={f.key} data-creveal={f.key} style={{ display: "grid", gridTemplateColumns: "minmax(56px, 96px) 1fr", gap: "clamp(16px,3vw,40px)", alignItems: "start", padding: "clamp(30px,4.5vh,48px) 0", borderTop: "1px solid #E8E0D2", opacity: r.op, transform: `translateY(${r.ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
              <span className="font-display" style={{ fontSize: "clamp(22px,2.6vw,32px)", fontWeight: 500, color: "#C9A24B", lineHeight: 1.3 }}>{f.num}</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, maxWidth: 760 }}>
                <h3 className="font-display" style={{ fontSize: "clamp(24px,3.2vw,42px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", lineHeight: 1.15 }}>{f.title}</h3>
                <p className="font-body" style={{ fontSize: "clamp(15px,1.6vw,17px)", lineHeight: 1.75, color: "#6E6353", maxWidth: "64ch" }}>{f.description}</p>
              </div>
            </div>
          );
        })}
        <div style={{ borderTop: "1px solid #E8E0D2" }} />
      </section>

      {/* Interlude band (static) */}
      <section style={{ position: "relative", height: "clamp(400px, 66vh, 640px)", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url('${IMG_DEITIES}')`, backgroundSize: "cover", backgroundPosition: "center 25%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.14) 22%, rgba(22,18,12,0.10) 50%, rgba(22,18,12,0.66) 100%)" }} />
        <div data-creveal="inter" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "0 clamp(24px,7vw,110px) clamp(40px,7vh,72px)", opacity: rev("inter").op, transform: `translateY(${rev("inter").ty})`, transition: "opacity 1.1s cubic-bezier(0.16,1,0.3,1), transform 1.1s cubic-bezier(0.16,1,0.3,1)" }}>
          <div aria-hidden style={{ width: 56, height: 1, background: "rgba(201,162,75,0.9)", marginBottom: 20 }} />
          <p className="font-display" style={{ fontSize: "clamp(1.4rem, 3.2vw, 2.6rem)", fontStyle: "italic", fontWeight: 500, color: "#FFF8E8", lineHeight: 1.3, maxWidth: 780, textShadow: "0 2px 30px rgba(22,18,12,0.5)", textWrap: "pretty" }}>Every feature serves one purpose: his words, found faithfully.</p>
        </div>
      </section>

      {/* CTA */}
      <section data-creveal="cta" style={{ padding: "clamp(70px,12vh,130px) clamp(24px,6vw,100px)", textAlign: "center", opacity: rev("cta").op, transform: `translateY(${rev("cta").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
        <h2 className="font-display" style={{ fontSize: "clamp(30px,4.4vw,58px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#201B12", marginBottom: 16, textWrap: "balance" }}>See it in motion</h2>
        <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,17px)", lineHeight: 1.7, color: "#6E6353", maxWidth: 460, margin: "0 auto 30px" }}>Ask a question and watch the answer weave itself from his books.</p>
        <Link href="/?ask=1" className="cine-cta-btn font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", borderRadius: 100, padding: "15px 38px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", boxShadow: "0 10px 34px rgba(107,87,201,0.30)", transition: "all 0.45s cubic-bezier(0.16,1,0.3,1)" }}><span>Try the search</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></Link>
      </section>

      <SiteFooter />
    </div>
  );
}
