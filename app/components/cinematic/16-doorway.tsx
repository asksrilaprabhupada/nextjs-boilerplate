/**
 * 16-doorway.tsx — The doorway (lock screen), cinematic redesign
 *
 * Designs: docs/redesign/designs/Main.dc.html (desktop and iPad) and
 * PhoneEntry.dc.html (phone). One full-screen photograph that changes every
 * 7 seconds with a 2.6-second film-style transition, "Ask" and "Śrīla
 * Prabhupāda" at the bottom centre, a thin gold rule, and one verse in small
 * italic with its speaker and source in gold. No button: a tap or click
 * anywhere (or Enter / Space) opens the site.
 *
 * Photos: the landscape set shows from 768 px up, the portrait set below. Each
 * photo is a CSS background. The first photo of each set comes from a
 * width-specific CSS rule, so a phone never downloads the landscape photo (and
 * the reverse); the rest of the visible set only are attached after the first
 * paint, once the screen width is known. All transitions are the
 * design's keyframes (app/redesign.css .asp-Lp*, .asp-Pp*, leak, bloom, flare).
 *
 * Verses: public/data/entrance-quotes.json. A random verse first, then every
 * 9 seconds another at random that was not among the last 12 shown, with the
 * design's ON / OUT / WAIT fade-and-rise (opacity and transform only).
 *
 * When it shows: on arrival only. `?entrance=0` skips it, and it shows at most
 * once a day per device (the date is kept in localStorage, inside try/catch).
 * The decision is made before the first paint by the inline script from
 * app/lib/29-doorway-decision.ts (rendered in app/layout.tsx) and written to
 * <html data-door>, so a skipped doorway never flashes and never loads.
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import quotesFile from "@/public/data/entrance-quotes.json";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface Verse { text: string; source: string }
const VERSES: readonly Verse[] = (quotesFile as { quotes: Verse[] }).quotes;


interface Slide {
  src: string;
  position: string;
  grade: string;
  blend: "soft-light" | "multiply";
}

const GRADE_WARM = "linear-gradient(165deg, rgba(255,176,90,0.55), rgba(140,70,20,0.45))";
const GRADE_TEAL = "linear-gradient(180deg, rgba(0,105,125,0.55), rgba(255,140,60,0.45))";
const GRADE_ROSE = "linear-gradient(170deg, rgba(255,150,175,0.5), rgba(95,45,100,0.5))";
const GRADE_VIOLET = "linear-gradient(160deg, rgba(139,110,224,0.6), rgba(255,200,120,0.35))";
const GRADE_SEPIA = "linear-gradient(170deg, rgba(196,150,90,0.45), rgba(120,80,40,0.4))";
const P = "/images/redesign/photos/";

/** Desktop and iPad: focus pull, light leak, push-through, exposure bloom, lens flare. */
const LANDSCAPE: readonly Slide[] = [
  { src: `${P}with-disciples.webp`, position: "center 28%", grade: GRADE_WARM, blend: "soft-light" },
  { src: `${P}vrindavan-deities.webp`, position: "56% 32%", grade: GRADE_TEAL, blend: "soft-light" },
  { src: `${P}new-york-1965.webp`, position: "70% 38%", grade: GRADE_ROSE, blend: "soft-light" },
  { src: `${P}jaladuta-1965.webp`, position: "center 50%", grade: GRADE_VIOLET, blend: "soft-light" },
  { src: `${P}morning-walk.webp`, position: "48% 40%", grade: GRADE_SEPIA, blend: "multiply" },
];

/** Phone: soft dissolve, light leak, push, bloom, dip to black, lens flare. */
const PORTRAIT: readonly Slide[] = [
  { src: `${P}folded-hands.webp`, position: "50% 18%", grade: GRADE_WARM, blend: "soft-light" },
  { src: `${P}with-disciples.webp`, position: "53% 28%", grade: GRADE_TEAL, blend: "soft-light" },
  { src: `${P}lecturing.webp`, position: "45% 22%", grade: GRADE_ROSE, blend: "soft-light" },
  { src: `${P}vrindavan-deities.webp`, position: "57% 30%", grade: GRADE_VIOLET, blend: "soft-light" },
  { src: `${P}paris.webp`, position: "50% 28%", grade: GRADE_SEPIA, blend: "multiply" },
  {
    src: `${P}new-york-1965.webp`,
    position: "72% 40%",
    grade: "radial-gradient(ellipse 80% 70% at 60% 30%, rgba(255,215,130,0.6), rgba(70,40,15,0.5))",
    blend: "soft-light",
  },
];

const EASE = "cubic-bezier(.16,1,.3,1)";
/* The design's verse states, without its letter-spacing settle (only opacity
   and transform may animate). */
const ON: CSSProperties = { opacity: 1, transform: "translate3d(0,0,0)", transition: `opacity 1.8s ${EASE} .6s, transform 1.8s ${EASE} .6s` };
const OUT: CSSProperties = { opacity: 0, transform: "translate3d(0,-14px,0)", transition: "opacity 1.1s ease, transform 1.1s ease" };
const WAIT: CSSProperties = { opacity: 0, transform: "translate3d(0,18px,0)", transition: "none" };
const SRC_ON: CSSProperties = { opacity: 1, transition: "opacity 1s ease 1.4s" };
const SRC_OFF: CSSProperties = { opacity: 0, transition: "opacity .5s ease" };

function pick(n: number, avoid: readonly number[]): number {
  let i = Math.floor(Math.random() * n);
  let guard = 0;
  while (avoid.includes(i) && guard < 50) {
    i = Math.floor(Math.random() * n);
    guard += 1;
  }
  return i;
}

/* The first photo of each set is attached by a width-specific CSS rule
   (app/redesign.css .asp-ph-first), which a browser never fetches when the
   rule does not apply; the rest are attached here once the set is known. */
function SlideLayer({ slide, className, image, first }: { slide: Slide; className: string; image: boolean; first: boolean }) {
  return (
    <div className={`asp-ph ${className}${first ? " asp-ph-first" : ""}`}>
      <div
        className="asp-ph-img"
        style={{ backgroundImage: image ? `url("${slide.src}")` : undefined, backgroundPosition: slide.position }}
      />
      <div className="asp-ph-grade" style={{ background: slide.grade, mixBlendMode: slide.blend }} />
    </div>
  );
}

export default function Doorway({ onShow, onOpen }: { onShow: () => void; onOpen: () => void }) {
  const [mounted, setMounted] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [restLoaded, setRestLoaded] = useState(false);
  const [verse, setVerse] = useState<{ cur: number; prev: number | null; recent: number[] }>({
    cur: -1,
    prev: null,
    recent: [],
  });
  const hitRef = useRef<HTMLButtonElement>(null);
  const openedRef = useRef(false);

  const open = useCallback(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    const root = document.documentElement;
    root.setAttribute("data-door", "leaving");
    setLeaving(true);
    onOpen();
    window.setTimeout(() => {
      root.setAttribute("data-door", "open");
      setMounted(false);
    }, 900);
  }, [onOpen]);

  // Skipped before paint (or reached by in-app navigation, where the inline
  // script does not run)? Then CSS already hides it: unmount before paint.
  useIsomorphicLayoutEffect(() => {
    if (document.documentElement.getAttribute("data-door") !== "show") {
      openedRef.current = true;
      setMounted(false);
      onOpen();
      return;
    }
    onShow();
    hitRef.current?.focus({ preventScroll: true });
  }, [onOpen, onShow]);

  // The rest of the photos load after the first paint, for the visible set only.
  useEffect(() => {
    if (!mounted || leaving) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setRestLoaded(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [mounted, leaving]);

  // Verses: a random first one, then a new one every 9 s (not when motion is
  // reduced — the first verse simply stays).
  useEffect(() => {
    if (!mounted || VERSES.length === 0) return;
    const start = Math.floor(Math.random() * VERSES.length);
    setVerse({ cur: start, prev: null, recent: [start] });
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* matchMedia unavailable: rotate */
    }
    if (reduce) return;
    const timer = window.setInterval(() => {
      setVerse((v) => {
        const next = pick(VERSES.length, [...v.recent, v.cur]);
        return { cur: next, prev: v.cur, recent: [...v.recent, next].slice(-12) };
      });
    }, 9000);
    return () => window.clearInterval(timer);
  }, [mounted]);

  // Enter or Space opens the site even when focus is elsewhere.
  useEffect(() => {
    if (!mounted || leaving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (document.documentElement.getAttribute("data-door") !== "show") return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mounted, leaving, open]);

  const [landscapeVisible, setLandscapeVisible] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setLandscapeVisible(window.matchMedia("(min-width: 768px)").matches);
    } catch {
      setLandscapeVisible(true);
    }
  }, []);

  if (!mounted) return null;

  const loadRest = (set: "L" | "P") =>
    restLoaded && landscapeVisible !== null && (set === "L" ? landscapeVisible : !landscapeVisible);

  return (
    <>
      <div className="asp-door" role="dialog" aria-modal="true" aria-label="Ask Śrīla Prabhupāda">
        <div aria-hidden="true" className="asp-layer" style={{ overflow: "hidden" }}>
          <div className="asp-door-set asp-door-set-L">
            <div className="asp-weave">
              {LANDSCAPE.map((slide, i) => (
                <SlideLayer key={slide.src} slide={slide} className={`asp-Lp${i}`} first={i === 0} image={i > 0 && loadRest("L")} />
              ))}
            </div>
            <div className="asp-fx asp-fx-leak asp-Lleak" />
            <div className="asp-fx asp-fx-bloom asp-Lbloom" />
            <div className="asp-fx asp-fx-flare asp-Lflare" />
          </div>
          <div className="asp-door-set asp-door-set-P">
            <div className="asp-weave">
              {PORTRAIT.map((slide, i) => (
                <SlideLayer key={slide.src} slide={slide} className={`asp-Pp${i}`} first={i === 0} image={i > 0 && loadRest("P")} />
              ))}
            </div>
            <div className="asp-fx asp-fx-leak asp-Pleak" />
            <div className="asp-fx asp-fx-bloom asp-Pbloom" />
            <div className="asp-fx asp-fx-flare asp-Pflare" />
          </div>
          <div className="asp-door-scrim asp-door-scrim-1" />
          <div className="asp-door-scrim asp-door-scrim-2" />
          <div className="asp-door-scrim asp-door-scrim-3" />
          <div className="asp-sweep" />
          <div className="asp-door-scrim asp-door-scrim-4" />
          <div className="asp-grain" />
        </div>
        <p className="asp-sr">Photographs of Śrīla Prabhupāda.</p>

        <div className="asp-door-copy">
          <div style={{ padding: "2px 0" }}>
            <p className="asp-door-ask asp-up1">Ask</p>
          </div>
          <div style={{ padding: "6px 0 8px" }}>
            <h1 className="asp-door-title asp-shine">Śrīla Prabhupāda</h1>
          </div>
          <div aria-hidden="true" className="asp-door-rule asp-rule-grow" />
          <div className="asp-door-verse asp-in">
            <div aria-hidden="true" className="asp-door-quote">“</div>
            <div className="asp-door-verses" aria-live="off">
              {VERSES.map((v, i) => {
                const isCur = i === verse.cur;
                return (
                  <div
                    key={`${i}-${v.source}`}
                    className="asp-v"
                    aria-hidden={isCur ? undefined : true}
                    style={isCur ? ON : i === verse.prev ? OUT : WAIT}
                  >
                    <p className="asp-v-text">{v.text}</p>
                    <p className="asp-v-src" style={isCur ? SRC_ON : SRC_OFF}>— {v.source}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <button ref={hitRef} type="button" className="asp-hit" aria-label="Open Ask Śrīla Prabhupāda" onClick={open} />
      </div>
    </>
  );
}
