/**
 * 05-journey-page.tsx — His Journey (client page body)
 *
 * A scroll-driven film in five chapters (1965 Jaladuta → seven dollars →
 * Matchless Gifts → the books → the world), with a fixed gold→violet timeline
 * rail that fills with scroll progress, an opening "1965" title reveal, a
 * parallax-free verse interlude, and a closing CTA back to search. A faithful
 * React port of the "His Journey" Claude Design prototype.
 */
"use client";

import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useCinematicReveal } from "./04-use-cinematic-reveal";

const IMG = {
  disciples: "/images/lockscreen/prabhupadaanddisciplessmiling.jpg",
  deities: "/images/lockscreen/Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg",
  walk: "/images/lockscreen/Srila-Prabhupada-on-morning-walk-in-Vrindavan-620x350.avif",
};

/* Reused wrappers so each chapter reads the same */
const yearStyle: React.CSSProperties = { position: "sticky", top: 108, fontSize: "clamp(30px,4vw,52px)", fontWeight: 500, color: "#C9A24B", lineHeight: 1, fontVariantNumeric: "lining-nums", letterSpacing: "0.01em" };

function ChapterFrame({ img, alt }: { img: string; alt: string }) {
  return (
    <div style={{ width: "100%", maxWidth: 720, height: "clamp(260px, 46vh, 440px)", borderRadius: 18, backgroundImage: `url('${img}')`, backgroundSize: "cover", backgroundPosition: "center", boxShadow: "0 20px 60px rgba(43,37,25,0.14)" }} role="img" aria-label={alt} />
  );
}

export default function JourneyPage() {
  const { rootRef, entered, rev } = useCinematicReveal({ railFill: true, revealMargin: 80 });

  const op = entered
    ? { kicker: 1, year: "0", sub: 1, subY: "0px" }
    : { kicker: 0, year: "108%", sub: 0, subY: "16px" };

  const chapterSection: React.CSSProperties = {
    display: "grid", gridTemplateColumns: "minmax(90px, 0.35fr) 1fr", gap: "clamp(20px,4vw,60px)",
    maxWidth: 1280, margin: "0 auto",
  };
  const kicker: React.CSSProperties = { fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", marginBottom: 20 };
  const h2: React.CSSProperties = { fontSize: "clamp(32px,5vw,64px)", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1, color: "#201B12", maxWidth: 680, textWrap: "pretty" };
  const body: React.CSSProperties = { fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.8, color: "#6E6353", maxWidth: "58ch", marginTop: 22 };

  return (
    <div ref={rootRef}>
      {/* Timeline rail */}
      <div aria-hidden style={{ position: "fixed", top: "15vh", bottom: "15vh", left: "clamp(12px, 2.6vw, 36px)", width: 1, background: "#E8E0D2", zIndex: 95 }}>
        <div data-rail-fill style={{ width: "100%", height: "0%", background: "linear-gradient(180deg, #C9A24B, #6B57C9)" }} />
      </div>

      <SiteHeader variant="overlay" />

      {/* ── OPENING ── */}
      <section style={{ minHeight: "100vh", position: "relative", overflow: "hidden", background: "#16120C", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "100px 24px 80px" }}>
        <div aria-hidden style={{ position: "absolute", top: "-30%", left: 0, width: "45%", height: "160%", background: "linear-gradient(90deg, transparent, rgba(255,244,214,0.10), transparent)", filter: "blur(30px)", animation: "lightSweep 11s ease-in-out infinite", pointerEvents: "none" }} />
        <svg aria-hidden viewBox="0 0 1200 140" preserveAspectRatio="none" style={{ position: "absolute", bottom: -2, left: 0, width: "200%", height: "clamp(70px, 12vh, 130px)", opacity: 0.16, animation: "waveDrift 26s linear infinite" }}>
          <path d="M0 90 Q 75 60 150 90 T 300 90 T 450 90 T 600 90 T 750 90 T 900 90 T 1050 90 T 1200 90 V 140 H 0 Z" fill="#6B57C9" />
          <path d="M0 108 Q 75 84 150 108 T 300 108 T 450 108 T 600 108 T 750 108 T 900 108 T 1050 108 T 1200 108 V 140 H 0 Z" fill="#C9A24B" opacity="0.7" />
        </svg>
        <p className="font-body" style={{ fontSize: "clamp(11px,1.3vw,14px)", fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "rgba(201,162,75,0.95)", marginLeft: "0.42em", opacity: op.kicker, transition: "opacity 1.2s ease 0.2s" }}>The journey</p>
        <div style={{ overflow: "hidden", padding: "10px 0 6px" }}>
          <h1 className="font-display" style={{ fontSize: "clamp(6rem, 22vw, 17rem)", fontWeight: 500, color: "#FFF8E8", letterSpacing: "-0.03em", lineHeight: 0.95, textShadow: "0 6px 60px rgba(22,18,12,0.5)", transform: `translateY(${op.year})`, transition: "transform 1.4s cubic-bezier(0.16,1,0.3,1) 0.4s" }}>1965</h1>
        </div>
        <p className="font-display" style={{ fontSize: "clamp(1.1rem, 2.6vw, 1.7rem)", fontStyle: "italic", color: "rgba(255,248,232,0.9)", maxWidth: 640, lineHeight: 1.6, marginTop: 18, textWrap: "pretty", opacity: op.sub, transform: `translateY(${op.subY})`, transition: "opacity 1.2s ease 1.1s, transform 1.2s cubic-bezier(0.16,1,0.3,1) 1.1s" }}>At sixty-nine, with a trunk of books and a handful of change, he boarded a cargo ship to New York.</p>
        <div aria-hidden style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, opacity: op.sub, transition: "opacity 1s ease 1.6s" }}>
          <span className="font-body" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(255,248,232,0.6)", marginLeft: "0.3em" }}>Scroll</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "scrollCue 2.2s ease-in-out infinite", color: "rgba(255,248,232,0.6)" }}><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </section>

      {/* ── CH 1 — THE JALADUTA ── */}
      <section data-creveal="ch1" style={{ ...chapterSection, padding: "clamp(90px,14vh,150px) clamp(24px,6vw,100px) clamp(60px,10vh,120px)" }}>
        <div><p className="font-display" style={{ ...yearStyle, opacity: rev("ch1").op, transition: "opacity 0.9s ease" }}>1965</p></div>
        <div>
          <p className="font-body" style={{ ...kicker, opacity: rev("ch1").op, transform: `translateY(${rev("ch1").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>Chapter one — the crossing</p>
          <h2 className="font-display" style={{ ...h2, maxWidth: 640, opacity: rev("ch1").op, transform: `translateY(${rev("ch1").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s" }}>Thirty-five days at sea aboard the <span style={{ fontStyle: "italic", color: "#6B57C9" }}>Jaladuta</span></h2>
          <p className="font-body" style={{ ...body, opacity: rev("ch1").op, transform: `translateY(${rev("ch1").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s" }}>A steam cargo ship from Calcutta. On the way he suffered two heart attacks — and kept writing in his diary, praying to make the message of Kṛṣṇa understandable to the Western world.</p>
          <div style={{ marginTop: 36, opacity: rev("ch1").op, transform: `translateY(${rev("ch1").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s" }}>
            <ChapterFrame img={IMG.walk} alt="Śrīla Prabhupāda — the crossing" />
          </div>
        </div>
      </section>

      {/* ── CH 2 — ARRIVAL ── */}
      <section data-creveal="ch2" style={{ ...chapterSection, padding: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)" }}>
        <div><p className="font-display" style={{ ...yearStyle, opacity: rev("ch2").op, transition: "opacity 0.9s ease" }}>1965</p></div>
        <div>
          <p className="font-body" style={{ ...kicker, opacity: rev("ch2").op, transform: `translateY(${rev("ch2").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>Chapter two — the arrival</p>
          <h2 className="font-display" style={{ ...h2, opacity: rev("ch2").op, transform: `translateY(${rev("ch2").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s" }}>He stepped ashore with about <span style={{ fontStyle: "italic", color: "#6B57C9" }}>seven dollars</span> and trunks of Śrīmad-Bhāgavatam</h2>
          <p className="font-body" style={{ ...body, opacity: rev("ch2").op, transform: `translateY(${rev("ch2").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s" }}>No institution behind him. No congregation waiting. Only the order of his spiritual master: carry these teachings to the English-speaking world.</p>
          <div style={{ marginTop: 36, opacity: rev("ch2").op, transform: `translateY(${rev("ch2").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s" }}>
            <ChapterFrame img={IMG.disciples} alt="Śrīla Prabhupāda — New York, 1965" />
          </div>
        </div>
      </section>

      {/* ── INTERLUDE — verse band (static) ── */}
      <section style={{ position: "relative", height: "clamp(440px, 76vh, 720px)", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url('${IMG.deities}')`, backgroundSize: "cover", backgroundPosition: "center 25%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.12) 20%, rgba(22,18,12,0.10) 48%, rgba(22,18,12,0.68) 100%)" }} />
        <div data-creveal="inter" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "0 clamp(24px,7vw,110px) clamp(44px,8vh,84px)", opacity: rev("inter").op, transform: `translateY(${rev("inter").ty})`, transition: "opacity 1.1s cubic-bezier(0.16,1,0.3,1), transform 1.1s cubic-bezier(0.16,1,0.3,1)" }}>
          <div aria-hidden style={{ width: 56, height: 1, background: "rgba(201,162,75,0.9)", marginBottom: 22 }} />
          <p className="font-display" style={{ fontSize: "clamp(1.4rem, 3.4vw, 2.8rem)", fontStyle: "italic", fontWeight: 500, color: "#FFF8E8", lineHeight: 1.3, maxWidth: 820, textShadow: "0 2px 30px rgba(22,18,12,0.5)", textWrap: "pretty" }}>&ldquo;Whatever action a great man performs, common men follow. And whatever standards he sets by exemplary acts, all the world pursues.&rdquo;</p>
          <p className="font-body" style={{ marginTop: 18, fontSize: 12, fontWeight: 600, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(201,162,75,1)" }}>Bhagavad Gītā 3.21</p>
        </div>
      </section>

      {/* ── CH 3 — MATCHLESS GIFTS ── */}
      <section data-creveal="ch3" style={{ ...chapterSection, padding: "clamp(80px,12vh,140px) clamp(24px,6vw,100px) clamp(60px,10vh,120px)" }}>
        <div><p className="font-display" style={{ ...yearStyle, opacity: rev("ch3").op, transition: "opacity 0.9s ease" }}>1966</p></div>
        <div>
          <p className="font-body" style={{ ...kicker, opacity: rev("ch3").op, transform: `translateY(${rev("ch3").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>Chapter three — the storefront</p>
          <h2 className="font-display" style={{ ...h2, opacity: rev("ch3").op, transform: `translateY(${rev("ch3").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s" }}>26 Second Avenue. A sign in the window: <span style={{ fontStyle: "italic", color: "#6B57C9" }}>Matchless Gifts</span></h2>
          <p className="font-body" style={{ ...body, opacity: rev("ch3").op, transform: `translateY(${rev("ch3").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s" }}>In a small Lower East Side storefront he began evening classes and kīrtana. In July 1966 he incorporated the International Society for Krishna Consciousness.</p>
          <div style={{ marginTop: 36, opacity: rev("ch3").op, transform: `translateY(${rev("ch3").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s" }}>
            <ChapterFrame img={IMG.deities} alt="Śrīla Prabhupāda — 26 Second Avenue" />
          </div>
        </div>
      </section>

      {/* ── CH 4 — THE BOOKS ── */}
      <section data-creveal="ch4" style={{ ...chapterSection, padding: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)" }}>
        <div><p className="font-display" style={{ ...yearStyle, opacity: rev("ch4").op, transition: "opacity 0.9s ease" }}>1968—77</p></div>
        <div>
          <p className="font-body" style={{ ...kicker, opacity: rev("ch4").op, transform: `translateY(${rev("ch4").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>Chapter four — the books</p>
          <h2 className="font-display" style={{ ...h2, opacity: rev("ch4").op, transform: `translateY(${rev("ch4").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s" }}>He rose before dawn, every day, to <span style={{ fontStyle: "italic", color: "#6B57C9" }}>translate</span></h2>
          <p className="font-body" style={{ ...body, opacity: rev("ch4").op, transform: `translateY(${rev("ch4").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s" }}>While travelling constantly, he produced more than eighty volumes — translations, purports, and essays. Those books are exactly what this site searches.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "clamp(20px,3vw,40px)", maxWidth: 720, marginTop: 36, opacity: rev("ch4").op, transform: `translateY(${rev("ch4").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s" }}>
            <div style={{ borderTop: "1px solid #D8CCB8", paddingTop: 18 }}>
              <p className="font-display" style={{ fontSize: "clamp(44px,5vw,72px)", fontWeight: 500, color: "#201B12", lineHeight: 1 }}>80+</p>
              <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.2em", textTransform: "uppercase", color: "#6B57C9", marginTop: 10 }}>Volumes written</p>
            </div>
            <div style={{ borderTop: "1px solid #D8CCB8", paddingTop: 18 }}>
              <p className="font-body" style={{ fontSize: "clamp(44px,5vw,72px)", fontWeight: 500, color: "#201B12", lineHeight: 1, fontVariantNumeric: "lining-nums" }}>1:00 a.m.</p>
              <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.2em", textTransform: "uppercase", color: "#6B57C9", marginTop: 10 }}>His writing hour</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CH 5 — THE WORLD ── */}
      <section data-creveal="ch5" style={{ ...chapterSection, padding: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)" }}>
        <div><p className="font-display" style={{ ...yearStyle, opacity: rev("ch5").op, transition: "opacity 0.9s ease" }}>1966—77</p></div>
        <div>
          <p className="font-body" style={{ ...kicker, opacity: rev("ch5").op, transform: `translateY(${rev("ch5").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>Chapter five — the world</p>
          <h2 className="font-display" style={{ ...h2, opacity: rev("ch5").op, transform: `translateY(${rev("ch5").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.12s" }}>Fourteen times around the world in <span style={{ fontStyle: "italic", color: "#6B57C9" }}>eleven years</span></h2>
          <p className="font-body" style={{ ...body, opacity: rev("ch5").op, transform: `translateY(${rev("ch5").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.24s" }}>Lecturing on six continents, opening more than a hundred temples, and writing letters — thousands of them — to guide the people he had met.</p>
          <div style={{ marginTop: 36, opacity: rev("ch5").op, transform: `translateY(${rev("ch5").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.36s" }}>
            <ChapterFrame img={IMG.disciples} alt="Śrīla Prabhupāda — travelling with devotees worldwide" />
          </div>
        </div>
      </section>

      {/* ── CLOSE — legacy CTA ── */}
      <section style={{ position: "relative", minHeight: "clamp(480px, 86vh, 760px)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url('${IMG.disciples}')`, backgroundSize: "cover", backgroundPosition: "center 28%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.30) 30%, rgba(22,18,12,0.55) 70%, rgba(22,18,12,0.80) 100%)" }} />
        <div data-creveal="close" style={{ position: "relative", zIndex: 1, textAlign: "center", padding: "80px 24px", opacity: rev("close").op, transform: `translateY(${rev("close").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
          <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color: "rgba(201,162,75,1)", marginBottom: 20 }}>1977 — today</p>
          <h2 className="font-display" style={{ fontSize: "clamp(36px,6vw,80px)", fontWeight: 600, lineHeight: 1.08, letterSpacing: "-0.02em", color: "#FFF8E8", marginBottom: 16, textShadow: "0 4px 44px rgba(22,18,12,0.5)", textWrap: "balance" }}>His words remain.</h2>
          <p className="font-display" style={{ fontSize: "clamp(18px,2.4vw,26px)", fontStyle: "italic", color: "rgba(255,248,232,0.9)", maxWidth: 560, margin: "0 auto 36px", textWrap: "pretty" }}>Every book, every lecture, every letter — preserved, and now searchable.</p>
          <Link href="/?ask=1" className="cine-enter-btn font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, background: "rgba(255,248,232,0.12)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", color: "#FFF8E8", border: "1px solid rgba(255,244,214,0.45)", borderRadius: 100, padding: "15px 38px", fontSize: 14, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer", transition: "all 0.45s cubic-bezier(0.16,1,0.3,1)" }}><span>Now, ask him</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
