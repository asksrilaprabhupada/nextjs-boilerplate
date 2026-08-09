/**
 * 05-journey-page.tsx — His Journey (client page body) — v2
 *
 * A scroll film in five chapters (1965 Jaladuta → seven dollars → Matchless
 * Gifts → the books → the world), opening on the Jaladuta photograph itself
 * rather than on flat black, with a fixed gold→violet timeline rail that fills
 * with scroll progress, a verse interlude after chapter two, and a closing
 * door back to the search.
 *
 * The header is scene-aware here (variant="scene"): light type over a soft
 * dark scrim while the opening frame fills the viewport, frosted paper below
 * it — so a pale bar never sits on top of the dark scene.
 *
 * Chapter photos are path-addressed slots under /images/journey/ — each shows
 * an honest placeholder until the exactly named file exists (note chapter
 * three's file is a .png).
 */
"use client";

import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useCinematicReveal } from "./04-use-cinematic-reveal";
import PhotoSlot, { useImageAvailable } from "./14-photo-slot";

const IMG = {
  disciples: "/images/lockscreen/prabhupadaanddisciplessmiling.jpg",
};

const JALADUTA = "/images/journey/journey-1965-jaladuta-ship.jpg";
const QUOTE_BACKGROUND = "/images/journey/journey-quote-background.jpg";

interface Chapter {
  key: string;
  year: string;
  kicker: string;
  head: React.ReactNode;
  body: string;
  photo: { src: string; alt: string; placeholderCaption: string };
  credit: string;
  pad: string;
  stats?: boolean;
}

const em = (t: string) => <span style={{ fontStyle: "italic", color: "#6B57C9" }}>{t}</span>;

const CHAPTERS: Chapter[] = [
  {
    key: "ch1",
    year: "1965",
    kicker: "Chapter one — the crossing",
    head: <>Thirty-five days at sea aboard the {em("Jaladuta")}</>,
    body: "A steam cargo ship from Calcutta. On the way he suffered two heart attacks — and kept writing in his diary, praying to make the message of Kṛṣṇa understandable to the Western world.",
    photo: { src: JALADUTA, alt: "The Jaladuta, the cargo ship that carried Śrīla Prabhupāda from Calcutta to New York, 1965", placeholderCaption: "Photograph coming — the Jaladuta, 1965" },
    credit: "The Jaladuta, 1965",
    pad: "clamp(90px,14vh,150px) clamp(24px,6vw,100px) clamp(60px,10vh,120px)",
  },
  {
    key: "ch2",
    year: "1965",
    kicker: "Chapter two — the arrival",
    head: <>He stepped ashore with about {em("seven dollars")} and trunks of Śrīmad-Bhāgavatam</>,
    body: "No institution behind him. No congregation waiting. Only the order of his spiritual master: carry these teachings to the English-speaking world.",
    photo: { src: "/images/journey/journey-1965-arrival-new-york.jpg", alt: "Śrīla Prabhupāda after arriving in New York, 1965", placeholderCaption: "Photograph coming — arrival in New York, 1965" },
    credit: "New York, 1965",
    pad: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)",
  },
  {
    key: "ch3",
    year: "1966",
    kicker: "Chapter three — the storefront",
    head: <>26 Second Avenue. A sign in the window: {em("Matchless Gifts")}</>,
    body: "In a small Lower East Side storefront he began evening classes and kīrtana. In July 1966 he incorporated the International Society for Krishna Consciousness.",
    photo: { src: "/images/journey/journey-1966-matchless-gifts-storefront.png", alt: "The Matchless Gifts storefront at 26 Second Avenue, New York, 1966", placeholderCaption: "Photograph coming — 26 Second Avenue, 1966" },
    credit: "26 Second Avenue, 1966",
    pad: "clamp(80px,12vh,140px) clamp(24px,6vw,100px) clamp(60px,10vh,120px)",
  },
  {
    key: "ch4",
    year: "1968—77",
    kicker: "Chapter four — the books",
    head: <>He rose before dawn, every day, to {em("translate")}</>,
    body: "While travelling constantly, he produced more than eighty volumes — translations, purports, and essays. Those books are exactly what this site searches.",
    photo: { src: "/images/journey/journey-books-translating.jpg", alt: "Śrīla Prabhupāda at work translating his books", placeholderCaption: "Photograph coming — translating the books" },
    credit: "At his desk, translating",
    pad: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)",
    stats: true,
  },
  {
    key: "ch5",
    year: "1966—77",
    kicker: "Chapter five — the world",
    head: <>Fourteen times around the world in {em("eleven years")}</>,
    body: "Lecturing on six continents, opening more than a hundred temples, and writing letters — thousands of them — to guide the people he had met.",
    photo: { src: "/images/journey/journey-1966-77-world.jpg", alt: "Śrīla Prabhupāda during his world travels, 1966–77", placeholderCaption: "Photograph coming — around the world, 1966–77" },
    credit: "Around the world, 1966–77",
    pad: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)",
  },
];

const EASE = "cubic-bezier(0.16,1,0.3,1)";

export default function JourneyPage({ deitiesImageUrl }: { deitiesImageUrl: string | null }) {
  const { rootRef, entered, rev } = useCinematicReveal({ railFill: true, revealDistance: 40, revealMargin: 60 });
  const quoteBgReady = useImageAvailable(QUOTE_BACKGROUND);

  const op = entered
    ? { kicker: 1, year: "0", sub: 1, subY: "0px" }
    : { kicker: 0, year: "108%", sub: 0, subY: "16px" };

  const chapter = (ch: Chapter) => {
    const r = rev(ch.key);
    const slide = (delay: string) => ({
      opacity: r.op,
      transform: `translateY(${r.ty})`,
      transition: `opacity 0.9s ${EASE} ${delay}, transform 0.9s ${EASE} ${delay}`,
    });
    return (
      <section key={ch.key} data-creveal={ch.key} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 0.35fr) 1fr", gap: "clamp(20px,4vw,60px)", maxWidth: 1280, margin: "0 auto", padding: ch.pad, boxSizing: "border-box" }}>
        <div>
          <p className="font-display" style={{ margin: 0, position: "sticky", top: 108, fontSize: "clamp(30px,4vw,52px)", fontWeight: 500, color: "#C9A24B", lineHeight: 1, fontVariantNumeric: "lining-nums", letterSpacing: "0.01em", opacity: r.op, transition: "opacity 0.9s ease" }}>{ch.year}</p>
        </div>
        <div>
          <p className="font-body" style={{ margin: "0 0 20px", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", ...slide("0s") }}>{ch.kicker}</p>
          <h2 className="font-display" style={{ margin: 0, fontSize: "clamp(32px,5vw,64px)", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1, color: "#201B12", maxWidth: 640, textWrap: "pretty", ...slide("0.12s") }}>{ch.head}</h2>
          <p className="font-body" style={{ margin: "22px 0 0", fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.8, color: "#6E6353", maxWidth: "58ch", ...slide("0.24s") }}>{ch.body}</p>

          {ch.stats && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "clamp(20px,3vw,40px)", maxWidth: 720, marginTop: 36, ...slide("0.36s") }}>
              <div style={{ borderTop: "1px solid #D8CCB8", paddingTop: 18 }}>
                <p className="font-display" style={{ margin: 0, fontSize: "clamp(44px,5vw,72px)", fontWeight: 500, color: "#201B12", lineHeight: 1 }}>80+</p>
                <p className="font-body" style={{ margin: "10px 0 0", fontSize: 12, fontWeight: 600, letterSpacing: "0.2em", textTransform: "uppercase", color: "#6B57C9" }}>Volumes written</p>
              </div>
              <div style={{ borderTop: "1px solid #D8CCB8", paddingTop: 18 }}>
                <p className="font-body" style={{ margin: 0, fontSize: "clamp(44px,5vw,72px)", fontWeight: 500, color: "#201B12", lineHeight: 1, fontVariantNumeric: "lining-nums" }}>1:00 a.m.</p>
                <p className="font-body" style={{ margin: "10px 0 0", fontSize: 12, fontWeight: 600, letterSpacing: "0.2em", textTransform: "uppercase", color: "#6B57C9" }}>His writing hour</p>
              </div>
            </div>
          )}

          <div style={{ marginTop: 36, ...slide("0.36s") }}>
            <figure className="cine-photo-zoom" style={{ margin: 0, maxWidth: 720 }}>
              <PhotoSlot {...ch.photo} frame={{ width: "100%", height: "clamp(260px, 46vh, 440px)" }} />
              <figcaption className="font-body" style={{ marginTop: 12, fontSize: 12, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A8F7D" }}>{ch.credit}</figcaption>
            </figure>
          </div>
        </div>
      </section>
    );
  };

  return (
    <div ref={rootRef}>
      {/* Film grade — a gentle vignette over the whole scroll */}
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none", background: "radial-gradient(120% 100% at 50% 42%, transparent 66%, rgba(22,18,12,0.12) 100%)" }} />

      {/* Timeline rail */}
      <div aria-hidden style={{ position: "fixed", top: "15vh", bottom: "15vh", left: "clamp(12px, 2.6vw, 36px)", width: 1, background: "rgba(232,224,210,0.5)", zIndex: 95 }}>
        <div data-rail-fill style={{ width: "100%", height: "0%", background: "linear-gradient(180deg, #C9A24B, #6B57C9)" }} />
      </div>

      <SiteHeader variant="scene" />

      {/* ── OPENING — 1965 over the Jaladuta itself ── */}
      <section style={{ minHeight: "100vh", position: "relative", overflow: "hidden", background: "#16120C", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "100px 24px 80px" }}>
        <div aria-hidden className="cine-scene-kenburns" style={{ position: "absolute", inset: 0, backgroundImage: `url('${JALADUTA}')`, backgroundSize: "cover", backgroundPosition: "center 45%", opacity: 0.38, filter: "saturate(0.9) brightness(0.85)" }} />
        <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(22,18,12,0.72) 0%, rgba(22,18,12,0.30) 40%, rgba(22,18,12,0.55) 74%, rgba(22,18,12,0.94) 100%)" }} />
        <div aria-hidden style={{ position: "absolute", top: "-30%", left: 0, width: "45%", height: "160%", background: "linear-gradient(90deg, transparent, rgba(255,244,214,0.10), transparent)", filter: "blur(30px)", animation: "lightSweep 11s ease-in-out infinite", pointerEvents: "none" }} />

        <div style={{ position: "relative", zIndex: 1 }}>
          <p className="font-body" style={{ margin: "0 0 0 0.42em", fontSize: "clamp(11px,1.3vw,14px)", fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "rgba(201,162,75,0.95)", opacity: op.kicker, transition: "opacity 1.1s ease 0.2s" }}>The journey</p>
          <div style={{ overflow: "hidden", padding: "10px 0 6px" }}>
            <h1 className="font-display" style={{ margin: 0, fontSize: "clamp(4rem, min(21vw, 30vh), 16rem)", fontWeight: 500, color: "#FFF8E8", letterSpacing: "-0.03em", lineHeight: 0.95, textShadow: "0 6px 60px rgba(22,18,12,0.6)", transform: `translateY(${op.year})`, transition: `transform 1.3s ${EASE} 0.35s` }}>1965</h1>
          </div>
          <p className="font-display" style={{ margin: "18px auto 0", fontSize: "clamp(1.1rem, 2.6vw, 1.7rem)", fontStyle: "italic", color: "rgba(255,248,232,0.92)", maxWidth: 640, lineHeight: 1.6, textWrap: "pretty", opacity: op.sub, transform: `translateY(${op.subY})`, transition: `opacity 1.1s ease 0.9s, transform 1.1s ${EASE} 0.9s` }}>At sixty-nine, with a trunk of books and a handful of change, he boarded a cargo ship to New York.</p>
          <p className="font-body" style={{ margin: "22px 0 0", fontSize: 11, fontWeight: 600, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(255,248,232,0.5)", opacity: op.sub, transition: "opacity 1.1s ease 1.2s" }}>The Jaladuta · Calcutta → New York · 35 days</p>
        </div>

        <div aria-hidden style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, opacity: op.sub, transition: "opacity 1s ease 1.5s" }}>
          <span className="font-body" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(255,248,232,0.6)", marginLeft: "0.3em" }}>Scroll</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "scrollCue 2.2s ease-in-out infinite", color: "rgba(255,248,232,0.6)" }}><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </section>

      {chapter(CHAPTERS[0])}
      {chapter(CHAPTERS[1])}

      {/* ── INTERLUDE — the verse he lived ── */}
      <section style={{ position: "relative", height: "clamp(440px, 76vh, 720px)", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: quoteBgReady ? `url('${QUOTE_BACKGROUND}')` : deitiesImageUrl ? `url('${deitiesImageUrl}')` : "none", backgroundSize: "cover", backgroundPosition: "center 25%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.12) 20%, rgba(22,18,12,0.10) 48%, rgba(22,18,12,0.68) 100%)" }} />
        <div data-creveal="inter" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "0 clamp(24px,7vw,110px) clamp(44px,8vh,84px)", opacity: rev("inter").op, transform: `translateY(${rev("inter").ty})`, transition: `opacity 1.1s ${EASE}, transform 1.1s ${EASE}` }}>
          <div aria-hidden style={{ width: 56, height: 1, background: "rgba(201,162,75,0.9)", marginBottom: 22 }} />
          <p className="font-display" style={{ margin: 0, fontSize: "clamp(1.4rem, 3.4vw, 2.8rem)", fontStyle: "italic", fontWeight: 500, color: "#FFF8E8", lineHeight: 1.3, maxWidth: 820, textShadow: "0 2px 30px rgba(22,18,12,0.5)", textWrap: "pretty" }}>&ldquo;Whatever action a great man performs, common men follow. And whatever standards he sets by exemplary acts, all the world pursues.&rdquo;</p>
          <p className="font-body" style={{ margin: "18px 0 0", fontSize: 12, fontWeight: 600, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(201,162,75,1)" }}>Bhagavad Gītā 3.21 · his translation</p>
        </div>
      </section>

      {chapter(CHAPTERS[2])}
      {chapter(CHAPTERS[3])}
      {chapter(CHAPTERS[4])}

      {/* ── CLOSE ── */}
      <section style={{ position: "relative", minHeight: "clamp(480px, 86vh, 760px)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: `url('${IMG.disciples}')`, backgroundSize: "cover", backgroundPosition: "center 28%" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.30) 30%, rgba(22,18,12,0.55) 70%, rgba(22,18,12,0.80) 100%)" }} />
        <div data-creveal="close" style={{ position: "relative", zIndex: 1, textAlign: "center", padding: "80px 24px", opacity: rev("close").op, transform: `translateY(${rev("close").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
          <p className="font-body" style={{ margin: "0 0 20px", fontSize: 12, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color: "rgba(201,162,75,1)" }}>1977 — today</p>
          <h2 className="font-display" style={{ margin: "0 0 16px", fontSize: "clamp(36px,6vw,80px)", fontWeight: 600, lineHeight: 1.08, letterSpacing: "-0.02em", color: "#FFF8E8", textShadow: "0 4px 44px rgba(22,18,12,0.5)", textWrap: "balance" }}>His words remain.</h2>
          <p className="font-display" style={{ margin: "0 auto 36px", fontSize: "clamp(18px,2.4vw,26px)", fontStyle: "italic", color: "rgba(255,248,232,0.9)", maxWidth: 560, textWrap: "pretty" }}>Every book, every lecture, every letter — preserved, and now searchable.</p>
          <Link href="/?entrance=0" className="cine-enter-btn font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, background: "rgba(255,248,232,0.12)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", color: "#FFF8E8", border: "1px solid rgba(255,244,214,0.45)", borderRadius: 100, padding: "15px 38px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", cursor: "pointer", transition: `all 0.45s ${EASE}` }}>
            <span>Now, ask him</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
