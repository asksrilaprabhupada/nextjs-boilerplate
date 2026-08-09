/**
 * 01-cinematic-home.tsx — Home (entrance + search) — v2
 *
 * The doorway, then the search. The entrance is now ONE composed frame rather
 * than a 26-second sequence of beats: the photograph fills the screen from the
 * first moment, "Ask Śrīla Prabhupāda" is settled by ~1.2 s, and one rotating
 * verse sits beneath it. There is no Enter button, no Skip, no letterbox and
 * no audio anywhere — clicking anywhere (or pressing Enter/Space) opens the
 * site. A radial scrim behind the wordmark keeps it legible over any of the
 * rotating photographs.
 *
 * The verse pool lives in public/data/entrance-quotes.json (bhāva and prema
 * only — Caitanya Mahāprabhu's Śikṣāṣṭakam, the Gosvāmīs, and the ācāryas of
 * the paramparā, in the translations Śrīla Prabhupāda gave). One is chosen at
 * random per visit and crossfades in over the deterministic first paint, so
 * anyone can add lines to that file without touching this component.
 *
 * Below the doorway the page is the search: gradient wordmark, the search bar,
 * the library counts, a calm Moments filmstrip (natural scroll — no pinned
 * hijack), the manifesto, a sharp 1965 teaser, honestly-labelled sample
 * voices, and a quiet door back to the top.
 *
 * Search seam: submitting a question hands off to /search?q=… (`runSearch`),
 * where the live pipeline answers. Internal links back to this page carry
 * ?entrance=0 so navigation never replays the doorway.
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { useSiteModals } from "./13-site-modals";
import PhotoSlot, { useImageAvailable } from "./14-photo-slot";
import type { SlideImage } from "@/app/lib/06-lockscreen-data";
import {
  drawLockscreenPhoto,
  LOCKSCREEN_DECK_STORAGE_KEY,
  parseLockscreenPhotoDeck,
} from "@/app/lib/27-lockscreen-photo-deck";

const EASE = "cubic-bezier(0.16,1,0.3,1)";

/** Fallback pool — the live list is public/data/entrance-quotes.json. */
const VERSES = [
  { text: "O my Lord, when will my eyes be decorated with tears of love flowing constantly when I chant Your holy name?", source: "Śrī Caitanya Mahāprabhu · Śikṣāṣṭakam 6" },
  { text: "O Govinda! Feeling Your separation, I am considering a moment to be like twelve years.", source: "Śrī Caitanya Mahāprabhu · Śikṣāṣṭakam 7" },
  { text: "When love of Godhead awakens in the heart, liberation herself stands before the devotee with folded hands, waiting to render service.", source: "Bilvamaṅgala Ṭhākura · Śrī Kṛṣṇa-karṇāmṛta" },
  { text: "Love of Godhead is dormant in everyone's heart. It has only to be awakened by the process of hearing and chanting.", source: "Purport, Caitanya-caritāmṛta · Śrīla Prabhupāda" },
];

const QUESTIONS = [
  "What is the purpose of human life?",
  "How to control the mind?",
  "What happens after death?",
  "Why chant Hare Kṛṣṇa?",
  "What is the soul?",
  "How to overcome anger and lust?",
  "What is real happiness?",
  "How do I begin devotional service?",
  "What is the goal of yoga?",
  "Who is Kṛṣṇa?",
  "How to make a home spiritual?",
  "What does surrender to God mean?",
];

const TW_QUESTIONS = [
  "What is the purpose of human life?",
  "How to overcome anger?",
  "What happens to the soul after death?",
  "Why is chanting Hare Kṛṣṇa important?",
];

/** Moments: path-addressed slots — upload the exact filename, no code change. */
const MOMENTS = [
  { src: "/images/moments/moments-01.jpg", alt: "Śrīla Prabhupāda in Vṛndāvana", caption: "01 — Vṛndāvana", placeholderCaption: "Photograph coming — Vṛndāvana", offset: false },
  { src: "/images/moments/moments-02.jpg", alt: "Śrīla Prabhupāda teaching", caption: "02 — Teaching", placeholderCaption: "Photograph coming — teaching", offset: true },
  { src: "/images/moments/moments-03.jpg", alt: "Śrīla Prabhupāda with his disciples", caption: "03 — With Disciples", placeholderCaption: "Photograph coming — with disciples", offset: false },
  { src: "/images/moments/moments-04.jpg", alt: "Śrīla Prabhupāda with his books", caption: "04 — The Books", placeholderCaption: "Photograph coming — the books", offset: true },
];

const JALADUTA = "/images/journey/journey-1965-jaladuta-ship.jpg";

const WHY = [
  { title: "His words, not AI's", body: "Answers are woven verbatim from his translations and purports. The search retrieves and connects — it never generates philosophy." },
  { title: "Exact citations, always", body: "Every reference links to Vedabase.io — the full verse, synonyms, and complete purport are one click away." },
  { title: "Verified before it renders", body: "Every rendered quote is checked against its source row in the library — nothing paraphrased slips through." },
];

/* Sample voices — deliberately labelled as samples until real ones arrive.
   TODO(owner): replace the three quotes and attributions below. */
const VOICES = [
  { quote: "I trace a topic across Gītā, Bhāgavatam, and purports in minutes. It has transformed how I prepare for class.", who: "Temple president" },
  { quote: "I can verify the exact source immediately — no more flipping through six books to find one purport.", who: "Bhakti-śāstrī student" },
  { quote: "As a new devotee, every answer links back to his actual words — so I know it's authentic.", who: "New devotee" },
];

const GRAIN_URI =
  "data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27160%27%20height=%27160%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%270.9%27%20numOctaves=%272%27%20stitchTiles=%27stitch%27/%3E%3CfeColorMatrix%20type=%27matrix%27%20values=%270%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200.55%200%27/%3E%3C/filter%3E%3Crect%20width=%27160%27%20height=%27160%27%20filter=%27url(%23n)%27/%3E%3C/svg%3E";

interface Props {
  showEntrance?: boolean;
  filmGrain?: boolean;
  showMotes?: boolean;
  introImages?: readonly SlideImage[];
}

interface Mote { left: string; bottom: string; size: number; gold: boolean; blur: string; mx: string; mo: number; anim: string }

const DEFAULT_INTRO_IMAGES: readonly SlideImage[] = [];

/** The doorway is decided before the browser paints, so ?entrance=0 never flashes it. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function CinematicHome({
  showEntrance = true,
  filmGrain = true,
  showMotes = true,
  introImages = DEFAULT_INTRO_IMAGES,
}: Props) {
  const router = useRouter();
  const { openModal } = useSiteModals();
  const rootRef = useRef<HTMLDivElement>(null);
  const parallaxRef = useRef<HTMLDivElement>(null);

  // Entrance
  const [lockVisible, setLockVisible] = useState(showEntrance);
  const [lockMounted, setLockMounted] = useState(showEntrance);
  const [beat, setBeat] = useState(0);
  const introPhotoUrls = useMemo(() => introImages.map((image) => image.url), [introImages]);
  const [photo, setPhoto] = useState<string | null>(introPhotoUrls.find(Boolean) ?? null);
  const [verse, setVerse] = useState(VERSES[0]);
  const [verseIn, setVerseIn] = useState(true);
  const entrancePhotoDrawnRef = useRef(false);

  // Hero
  const [heroIn, setHeroIn] = useState(!showEntrance);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [twText, setTwText] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [footerNear, setFooterNear] = useState(false);
  const [motes, setMotes] = useState<Mote[]>([]);

  // Scroll reveals
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [stats, setStats] = useState({ books: 36, lectures: 3700, letters: 6500 });
  const countStarted = useRef(false);

  const jaladutaReady = useImageAvailable(JALADUTA);

  // Internal navigation carries ?entrance=0 — the doorway is for arrivals only.
  // Resolved in a layout effect (pre-paint) so the prerendered markup still
  // contains the doorway, and skipping it never shows a frame of it.
  const skipRef = useRef(false);
  useIsomorphicLayoutEffect(() => {
    const skip = !showEntrance || new URLSearchParams(window.location.search).get("entrance") === "0";
    skipRef.current = skip;
    if (skip) {
      setLockVisible(false);
      setLockMounted(false);
      setHeroIn(true);
      setBeat(3);
    }
  }, [showEntrance]);

  /* ── Entrance photograph: one cryptographically shuffled draw per arrival ── */
  useEffect(() => {
    if (skipRef.current || entrancePhotoDrawnRef.current) return;
    entrancePhotoDrawnRef.current = true;

    let persisted: ReturnType<typeof parseLockscreenPhotoDeck> = null;
    try {
      persisted = parseLockscreenPhotoDeck(sessionStorage.getItem(LOCKSCREEN_DECK_STORAGE_KEY));
    } catch {
      // Storage can be blocked; selection still uses Web Crypto below.
    }

    try {
      const selection = drawLockscreenPhoto(introPhotoUrls, persisted);
      if (selection.photo) setPhoto(selection.photo);
      try {
        sessionStorage.setItem(LOCKSCREEN_DECK_STORAGE_KEY, JSON.stringify(selection.state));
      } catch {
        // The photo remains random even when persistence is unavailable.
      }
    } catch {
      // Web Crypto is universal in supported browsers; retain the first frame if unavailable.
    }
  }, [introPhotoUrls]);

  /* ── Entrance: one composed frame, settled by ~2s ── */
  useEffect(() => {
    if (skipRef.current) return;
    const timers = [
      setTimeout(() => setBeat(1), 150),
      setTimeout(() => setBeat(2), 450),
      setTimeout(() => setBeat(3), 900),
    ];
    return () => timers.forEach(clearTimeout);
  }, [showEntrance]);

  /* ── The verse pool: editable JSON, random per visit, crossfaded in ── */
  useEffect(() => {
    if (skipRef.current) return;
    let alive = true;
    const swap = (next: { text: string; source: string }) => {
      if (!alive) return;
      setVerseIn(false);
      window.setTimeout(() => {
        if (!alive) return;
        setVerse(next);
        setVerseIn(true);
      }, 300);
    };
    fetch("/data/entrance-quotes.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list: { text: string; source: string }[] | null = d && Array.isArray(d.quotes) ? d.quotes : null;
        if (!list || !list.length) {
          swap(VERSES[Math.floor(Math.random() * VERSES.length)]);
          return;
        }
        swap(list[Math.floor(Math.random() * list.length)]);
      })
      .catch(() => swap(VERSES[Math.floor(Math.random() * VERSES.length)]));
    return () => { alive = false; };
  }, [showEntrance]);

  const dismiss = useCallback(() => {
    setLockVisible((visible) => {
      if (!visible) return visible;
      setHeroIn(true);
      window.setTimeout(() => setLockMounted(false), 1000);
      return false;
    });
  }, []);

  /* ── Keyboard: Enter/Space opens the door, Escape closes overlays ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && lockVisible) { e.preventDefault(); dismiss(); }
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lockVisible, dismiss]);

  /* ── Light motes (client-only so SSR markup matches) ── */
  useEffect(() => {
    if (!showMotes || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    setMotes(Array.from({ length: 14 }, (_, i) => ({
      left: `${rand(4, 96)}%`,
      bottom: `${rand(-10, 40)}%`,
      size: rand(3, 6),
      gold: i % 3 === 0,
      blur: `blur(${rand(0.5, 2.2)}px)`,
      mx: `${rand(-60, 60)}px`,
      mo: rand(0.3, 0.65),
      anim: `moteDrift ${rand(11, 22).toFixed(1)}s linear ${rand(0, 12).toFixed(1)}s infinite`,
    })));
  }, [showMotes]);

  /* ── Typewriter placeholder ── */
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTwText(TW_QUESTIONS[0]);
      return;
    }
    let q = 0, char = 0, phase: "typing" | "pausing" | "erasing" = "typing";
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      const text = TW_QUESTIONS[q % TW_QUESTIONS.length];
      if (phase === "typing") {
        if (char < text.length) { char += 1; setTwText(text.slice(0, char)); timer = setTimeout(run, 50); }
        else { phase = "pausing"; timer = setTimeout(run, 3000); }
      } else if (phase === "pausing") { phase = "erasing"; timer = setTimeout(run, 0); }
      else if (char > 0) { char -= 1; setTwText(text.slice(0, char)); timer = setTimeout(run, 25); }
      else { q += 1; phase = "typing"; timer = setTimeout(run, 200); }
    };
    run();
    return () => clearTimeout(timer);
  }, []);

  /* ── Scroll reveals (+ the 1.5s failsafe) and the footer-aware FAB ── */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const key = entry.target.getAttribute("data-creveal");
        if (key) setRevealed((s) => ({ ...s, [key]: true }));
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -60px 0px" });
    root.querySelectorAll("[data-creveal]").forEach((el) => io.observe(el));

    const revealAll = () => {
      const all: Record<string, boolean> = {};
      root.querySelectorAll("[data-creveal]").forEach((el) => {
        const k = el.getAttribute("data-creveal");
        if (k) all[k] = true;
      });
      setRevealed((s) => ({ ...all, ...s }));
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) revealAll();
    else timers.push(setTimeout(revealAll, 1500));

    const foot = root.querySelector("footer");
    let footIo: IntersectionObserver | null = null;
    if (foot) {
      footIo = new IntersectionObserver((entries) => {
        entries.forEach((en) => setFooterNear(en.isIntersecting));
      }, { threshold: 0.05 });
      footIo.observe(foot);
    }

    return () => { timers.forEach(clearTimeout); io.disconnect(); footIo?.disconnect(); };
  }, []);

  /* ── Library counts ease up the first time the section is seen ── */
  useEffect(() => {
    if (!revealed.lib || countStarted.current) return;
    countStarted.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const targets = { books: 36, lectures: 3700, letters: 6500 };
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min((now - start) / 2400, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setStats({
        books: Math.round(e * targets.books),
        lectures: Math.round(e * targets.lectures),
        letters: Math.round(e * targets.letters),
      });
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setStats({ books: 0, lectures: 0, letters: 0 });
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [revealed.lib]);

  /* ── The 1965 teaser drifts a little slower than the page ── */
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const loop = () => {
      const el = parallaxRef.current;
      const parent = el?.parentElement;
      if (el && parent) {
        const r = parent.getBoundingClientRect();
        el.style.transform = `translateY(${(-(r.top + r.height / 2 - window.innerHeight / 2) * 0.12).toFixed(1)}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  }, [router]);

  const rev = (k: string) => (revealed[k] ? { op: 1, ty: "0px" } : { op: 0, ty: "40px" });
  const num = (n: number) => n.toLocaleString("en-US");

  const hero = heroIn
    ? { l: "0", formOp: 1, formY: "0px" }
    : { l: "110%", formOp: 0, formY: "28px" };
  const canSubmit = query.trim().length > 0;

  const libCards = useMemo(() => [
    { n: num(stats.books), label: "Books", desc: "Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, and 32 more titles.", delay: "0.2s" },
    { n: `${num(stats.lectures)}+`, label: "Lectures", desc: "Transcribed lectures, conversations, and morning walks spanning decades of teaching.", delay: "0.35s" },
    { n: `${num(stats.letters)}+`, label: "Letters", desc: "Personal correspondence and instructions to disciples, friends, and world leaders.", delay: "0.5s" },
  ], [stats]);

  const sectionRule = (label: string, trailing?: string) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
      <p className="font-body" style={{ margin: 0, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>{label}</p>
      <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
      {trailing && <p className="font-display" style={{ margin: 0, fontSize: "clamp(18px,2vw,24px)", fontStyle: "italic", color: "#9A8F7D", whiteSpace: "nowrap" }}>{trailing}</p>}
    </div>
  );

  return (
    <div ref={rootRef}>
      {/* Film grade — a gentle vignette, and the optional grain */}
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none", background: "radial-gradient(120% 100% at 50% 42%, transparent 66%, rgba(22,18,12,0.12) 100%)" }} />
      {filmGrain && (
        <div aria-hidden className="film-grain-anim" style={{ position: "fixed", inset: "-12%", zIndex: 3000, pointerEvents: "none", opacity: 0.04, backgroundImage: `url("${GRAIN_URI}")`, backgroundSize: "160px 160px" }} />
      )}

      {/* ═══════ THE DOORWAY ═══════ */}
      {lockMounted && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Enter the site"
          onClick={dismiss}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#16120C", cursor: "pointer", overflow: "hidden", opacity: lockVisible ? 1 : 0, transition: "opacity 0.9s cubic-bezier(0.4,0,0.2,1)", pointerEvents: lockVisible ? "auto" : "none" }}
        >
          {/* The photograph — never cropped away from his face */}
          {photo && (
            <div style={{ position: "absolute", inset: 0, opacity: beat >= 1 ? 1 : 0, transition: "opacity 1.6s cubic-bezier(0.4,0,0.2,1)" }}>
              <div aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: `url('${photo}')`, backgroundSize: "cover", backgroundPosition: "center 30%", filter: "blur(30px) saturate(1.05) brightness(0.62)", transform: "scale(1.12)" }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="cine-door-photo" src={photo} alt="" aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 28%" }} />
              <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(22,18,12,0.42) 0%, rgba(22,18,12,0.10) 30%, rgba(22,18,12,0.46) 60%, rgba(22,18,12,0.92) 100%)" }} />
              <div aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(115% 62% at 50% 88%, rgba(22,18,12,0.62), rgba(22,18,12,0.28) 55%, transparent 78%)" }} />
              <div aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 50% 92%, rgba(201,162,75,0.16), transparent 55%)" }} />
              <div aria-hidden style={{ position: "absolute", top: "-30%", left: 0, width: "45%", height: "160%", background: "linear-gradient(90deg, transparent, rgba(255,244,214,0.16), transparent)", filter: "blur(30px)", animation: "lightSweep 11s ease-in-out infinite", pointerEvents: "none" }} />
            </div>
          )}

          {/* Identity first — name settled by ~1.2s, then one verse */}
          <div style={{ position: "relative", zIndex: 5, height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", padding: "88px 24px clamp(56px, 13vh, 130px)", textAlign: "center", transform: `translateY(${lockVisible ? "0px" : "-50px"})`, transition: "transform 0.9s cubic-bezier(0.4,0,0.2,1)" }}>
            <div style={{ overflow: "hidden", padding: "2px 0" }}>
              <p className="font-body" style={{ margin: "0 0 0 0.42em", fontSize: "clamp(11px,1.3vw,14px)", fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#FFF3D6", textShadow: "0 2px 18px rgba(22,18,12,0.9), 0 0 34px rgba(22,18,12,0.7)", transform: `translateY(${beat >= 2 ? "0" : "110%"})`, transition: `transform 0.9s ${EASE} 0.35s` }}>Ask</p>
            </div>
            <div style={{ overflow: "hidden", padding: "6px 0 8px" }}>
              <h1 className="font-display" style={{ margin: 0, fontSize: "clamp(2.4rem, min(9vw, 11vh), 7.4rem)", fontWeight: 600, color: "#FFF8E8", letterSpacing: "-0.02em", lineHeight: 1.02, textShadow: "0 4px 44px rgba(22,18,12,0.75), 0 2px 14px rgba(22,18,12,0.6)", transform: `translateY(${beat >= 2 ? "0" : "110%"})`, transition: `transform 1.05s ${EASE} 0.5s` }}>Śrīla Prabhupāda</h1>
            </div>
            <div aria-hidden style={{ width: beat >= 2 ? 120 : 0, maxWidth: 120, height: 1, background: "linear-gradient(90deg, transparent, rgba(201,162,75,0.9), transparent)", margin: "6px auto 14px", transition: `width 1.2s ${EASE} 0.9s` }} />
            <div style={{ position: "relative", maxWidth: 640, margin: "0 auto", opacity: beat >= 3 ? 1 : 0, transition: "opacity 1.1s ease 1.1s" }}>
              <div aria-hidden style={{ fontFamily: "Georgia, serif", fontSize: 50, lineHeight: 1, color: "rgba(201,162,75,0.42)", textShadow: "0 2px 20px rgba(22,18,12,0.9)", marginBottom: -12, userSelect: "none" }}>&ldquo;</div>
              <p className="font-display" style={{ margin: 0, fontSize: "clamp(16px,1.95vw,21px)", fontStyle: "italic", color: "rgba(255,248,232,0.95)", textShadow: "0 2px 16px rgba(22,18,12,0.85)", lineHeight: 1.56, textWrap: "pretty", opacity: verseIn ? 1 : 0, transition: "opacity 0.55s ease" }}>{verse.text}</p>
              <p className="font-body" style={{ margin: "16px 0 0", fontSize: 11, fontWeight: 600, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(201,162,75,0.95)", opacity: verseIn ? 1 : 0, transition: "opacity 0.55s ease" }}>— {verse.source}</p>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ MORE QUESTIONS ═══════ */}
      {moreOpen && (
        <div role="dialog" aria-label="Example questions" onClick={() => setMoreOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", padding: "clamp(20px,5vw,60px)", background: "radial-gradient(120% 100% at 50% 30%, rgba(45,36,80,0.42), rgba(22,18,12,0.66))", backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)", animation: "moreOverlayIn 0.5s ease both" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", width: "100%", maxWidth: 760, maxHeight: "86vh", overflowY: "auto", padding: "clamp(32px,4vw,52px)", borderRadius: 28, background: "linear-gradient(160deg, rgba(254,252,248,0.98), rgba(250,247,241,0.96))", border: "1px solid rgba(255,255,255,0.6)", boxShadow: "0 40px 120px rgba(22,18,12,0.5), 0 0 0 1px rgba(107,87,201,0.08)", animation: `morePanelIn 0.7s ${EASE} both` }}>
            <button onClick={() => setMoreOpen(false)} aria-label="Close" className="cine-close" style={{ position: "absolute", top: 18, right: 18, width: 38, height: 38, borderRadius: "50%", border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <p className="font-body" style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color: "#6B57C9", textAlign: "center" }}>Ask him anything</p>
            <h2 className="font-display" style={{ margin: "8px 0 4px", fontSize: "clamp(26px,3.4vw,40px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center" }}>Where would you like to begin?</h2>
            <p className="font-display" style={{ margin: "0 0 clamp(26px,3vh,36px)", fontSize: "clamp(15px,1.8vw,19px)", fontStyle: "italic", color: "#6E6353", textAlign: "center" }}>Choose a question — his own words will answer.</p>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
              {QUESTIONS.map((q, i) => (
                <button key={q} onClick={() => { setMoreOpen(false); runSearch(q); }} className="cine-overlay-pill font-body"
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "11px 20px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", fontSize: 14, color: "#2B2519", cursor: "pointer", whiteSpace: "nowrap", opacity: 0, animation: `moreCardIn 0.6s ${EASE} both`, animationDelay: `${(0.14 + i * 0.05).toFixed(2)}s`, transition: "background 0.3s, border-color 0.3s, color 0.3s, box-shadow 0.3s, transform 0.3s" }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <SiteHeader variant="overlay" />

      {/* Feedback FAB — no audio controls anywhere on the site */}
      {!lockVisible && (
        <button aria-label="Send feedback" onClick={() => openModal("feedback")} className="cine-fab font-body"
          style={{ position: "fixed", bottom: 20, right: 20, zIndex: 500, display: "inline-flex", alignItems: "center", gap: 9, padding: "13px 22px", borderRadius: 100, border: "1px solid rgba(255,244,214,0.35)", background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFF8E8", fontSize: 13, fontWeight: 500, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "0 10px 34px rgba(107,87,201,0.35)", animation: `fabIn 0.9s ${EASE} 0.6s backwards`, opacity: footerNear ? 0 : 1, transform: footerNear ? "translateY(18px) scale(0.92)" : "translateY(0px) scale(1)", pointerEvents: footerNear ? "none" : "auto", transition: `opacity 0.4s ease, transform 0.5s ${EASE}, box-shadow 0.35s ease` }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
          <span>Feedback</span>
        </button>
      )}

      {/* ═══════ THE PAGE ═══════ */}
      <div style={{ opacity: lockVisible ? 0 : 1, transform: `scale(${lockVisible ? 0.98 : 1})`, transformOrigin: "50% 20%", transition: `opacity 1.0s ease 0.2s, transform 1.2s ${EASE} 0.1s`, minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative", zIndex: 2 }}>
        <main style={{ flex: 1 }}>

          {/* ── HERO — the search IS the page ── */}
          <section style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px clamp(16px,4vw,80px) 60px", position: "relative", overflow: "hidden" }}>
            <div aria-hidden style={{ position: "absolute", top: "44%", left: "50%", width: "min(90vw,760px)", height: "min(90vw,760px)", borderRadius: "50%", background: "radial-gradient(circle, rgba(139,110,224,0.26) 0%, rgba(201,162,75,0.09) 40%, transparent 70%)", filter: "blur(52px)", transform: "translate(-50%,-50%)", animation: "auraBreathe 9s ease-in-out infinite", pointerEvents: "none" }} />
            {showMotes && motes.length > 0 && (
              <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
                {motes.map((m, i) => (
                  <span key={i} style={{ position: "absolute", left: m.left, bottom: m.bottom, width: m.size, height: m.size, borderRadius: "50%", background: m.gold ? "rgba(201,162,75,0.6)" : "rgba(139,110,224,0.5)", filter: m.blur, animation: m.anim, pointerEvents: "none", ["--mx" as string]: m.mx, ["--mo" as string]: m.mo }} />
                ))}
              </div>
            )}

            <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: 880 }}>
              <div style={{ overflow: "hidden", padding: "2px 0" }}>
                <p className="font-body" style={{ margin: "0 0 0 0.42em", fontSize: "clamp(11px,1.2vw,13px)", fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#9A8F7D", transform: `translateY(${hero.l})`, transition: `transform 0.9s ${EASE} 0.15s` }}>Ask</p>
              </div>
              <div style={{ overflow: "hidden", padding: "8px 0 6px", maxWidth: "100%" }}>
                <h1 className="font-display" style={{ margin: 0, fontSize: "clamp(44px, 9.5vw, 128px)", fontWeight: 600, textAlign: "center", letterSpacing: "-0.03em", lineHeight: 1.02, background: "linear-gradient(120deg, #201B12 20%, #6B57C9 55%, #C9A24B 90%)", backgroundSize: "220% 220%", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", animation: "gradientText 10s ease-in-out infinite alternate", transform: `translateY(${hero.l})`, transition: `transform 1.1s ${EASE} 0.3s`, overflowWrap: "break-word" }}>Śrīla Prabhupāda</h1>
              </div>
              <div style={{ overflow: "hidden", padding: "2px 0" }}>
                <p className="font-display" style={{ margin: 0, fontSize: "clamp(17px, 2.4vw, 24px)", fontStyle: "italic", fontWeight: 500, textAlign: "center", color: "#6E6353", transform: `translateY(${hero.l})`, transition: `transform 1.0s ${EASE} 0.5s` }}>Nothing added. Nothing invented.</p>
              </div>

              <form onSubmit={(e) => { e.preventDefault(); runSearch(query); }} style={{ width: "100%", maxWidth: 720, position: "relative", marginTop: 40, opacity: hero.formOp, transform: `translateY(${hero.formY})`, transition: `opacity 0.9s ease 0.7s, transform 0.9s ${EASE} 0.7s` }}>
                <div style={{ position: "relative", borderRadius: 20, padding: 1.5, background: `linear-gradient(135deg, ${focused ? "rgba(107,87,201,0.72)" : "rgba(107,87,201,0.40)"}, ${focused ? "rgba(201,162,75,0.5)" : "rgba(201,162,75,0.26)"})`, boxShadow: focused ? "0 0 0 4px rgba(107,87,201,0.10), 0 18px 60px rgba(107,87,201,0.16)" : "0 2px 6px rgba(43,37,25,0.05), 0 18px 50px rgba(43,37,25,0.08)", transition: "background 0.3s cubic-bezier(0.2,0,0,1), box-shadow 0.5s cubic-bezier(0.2,0,0,1)" }}>
                  <textarea
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => { if (!query) setFocused(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSearch(query); } }}
                    aria-label="Search Prabhupāda's books"
                    rows={1}
                    className="font-body"
                    style={{ width: "100%", display: "block", padding: "22px clamp(100px,16vw,120px) 22px clamp(18px,3vw,28px)", fontSize: "clamp(15px,2.8vw,18px)", fontWeight: 400, border: "none", borderRadius: 18, background: "#FEFCF8", color: "#2B2519", outline: "none", resize: "none", overflow: "hidden", lineHeight: 1.5, boxSizing: "border-box" }}
                  />
                  {!query && !focused && (
                    <span aria-hidden className="font-body" style={{ position: "absolute", left: 28, top: 24, right: 104, fontSize: "clamp(15px,2.8vw,18px)", color: "#6E6353", pointerEvents: "none", display: "flex", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap" }}>
                      {twText}
                      <span style={{ display: "inline-block", width: 2, height: "1.2em", background: "#6B57C9", marginLeft: 1, animation: "typewriterBlink 0.8s step-end infinite", opacity: 0.7 }} />
                    </span>
                  )}
                  {!query && focused && (
                    <span aria-hidden className="font-body" style={{ position: "absolute", left: 28, top: 24, right: 104, fontSize: "clamp(15px,2.8vw,18px)", color: "#9A8F7D", pointerEvents: "none", lineHeight: 1.5, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>Ask anything about the scriptures...</span>
                  )}
                  <button type="submit" aria-label="Search" className="cine-submit-btn" style={{ position: "absolute", right: 10, top: 12, width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", cursor: canSubmit ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", opacity: canSubmit ? 1 : 0.4, transition: "all 0.3s cubic-bezier(0.2,0,0,1)", boxShadow: canSubmit ? "0 4px 14px rgba(107,87,201,0.30)" : "none" }}>
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                </div>
              </form>

              <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 8, opacity: hero.formOp, transition: "opacity 0.9s ease 0.95s" }}>
                {QUESTIONS.slice(0, 3).map((q) => (
                  <button key={q} onClick={() => runSearch(q)} className="cine-pill font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.8)", fontSize: 13, color: "#2B2519", cursor: "pointer", transition: "all 0.35s cubic-bezier(0.2,0,0,1)", whiteSpace: "nowrap" }}>{q}</button>
                ))}
                <button onClick={() => setMoreOpen(true)} className="cine-more-pill font-body" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 100, border: "1px dashed rgba(107,87,201,0.35)", background: "rgba(107,87,201,0.05)", fontSize: 13, fontWeight: 500, color: "#51409A", cursor: "pointer", transition: "all 0.35s cubic-bezier(0.2,0,0,1)", whiteSpace: "nowrap" }}>
                  More questions
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              </div>

              <p className="font-body" style={{ margin: "26px 0 0", fontSize: 12.5, fontWeight: 500, letterSpacing: "0.04em", color: "#9A8F7D", textAlign: "center", opacity: hero.formOp, transition: "opacity 0.9s ease 1.1s" }}>36 books · 3,700 lectures · 6,500 letters — every answer verbatim, every citation linked</p>
            </div>

            <div aria-hidden style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, opacity: hero.formOp, transition: "opacity 1s ease 1.4s" }}>
              <span className="font-body" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.3em", textTransform: "uppercase", color: "#9A8F7D", marginLeft: "0.3em" }}>Scroll</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "scrollCue 2.2s ease-in-out infinite", color: "#9A8F7D" }}><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
          </section>

          {/* ── THE LIBRARY ── */}
          <section data-creveal="lib" style={{ padding: "clamp(80px,12vh,140px) clamp(24px,6vw,100px)", maxWidth: 1280, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
            <div style={{ marginBottom: "clamp(40px,6vh,64px)", opacity: rev("lib").op, transform: `translateY(${rev("lib").ty})`, transition: `opacity 0.9s ${EASE}, transform 0.9s ${EASE}` }}>
              {sectionRule("The library")}
            </div>
            <h2 className="font-display" style={{ margin: "0 0 clamp(48px,8vh,80px)", fontSize: "clamp(30px,4.4vw,58px)", fontWeight: 600, lineHeight: 1.12, letterSpacing: "-0.02em", color: "#201B12", maxWidth: 760, textWrap: "pretty", opacity: rev("lib").op, transform: `translateY(${rev("lib").ty})`, transition: `opacity 0.9s ${EASE} 0.1s, transform 0.9s ${EASE} 0.1s` }}>
              Everything he wrote and spoke, <span className="headline-two-line" style={{ fontStyle: "italic", color: "#6B57C9" }}>searched together.</span>
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "clamp(32px,4vw,56px)" }}>
              {libCards.map((c) => (
                <div key={c.label} style={{ borderTop: "1px solid #D8CCB8", paddingTop: 26, opacity: rev("lib").op, transform: `translateY(${rev("lib").ty})`, transition: `opacity 0.9s ${EASE} ${c.delay}, transform 0.9s ${EASE} ${c.delay}` }}>
                  <p className="font-display" style={{ margin: 0, fontSize: "clamp(64px,8vw,120px)", fontWeight: 500, letterSpacing: "-0.03em", color: "#201B12", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{c.n}</p>
                  <h3 className="font-body" style={{ margin: "14px 0 10px", fontSize: 13, fontWeight: 600, letterSpacing: "0.22em", textTransform: "uppercase", color: "#6B57C9" }}>{c.label}</h3>
                  <p className="font-body" style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: "#6E6353", maxWidth: "34ch" }}>{c.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── MOMENTS — calm filmstrip, natural scroll ── */}
          <section data-creveal="moments" style={{ padding: "0 0 clamp(80px,12vh,140px)", overflow: "hidden" }}>
            <div style={{ maxWidth: 1280, margin: "0 auto 34px", padding: "0 clamp(24px,6vw,100px)", boxSizing: "border-box", opacity: rev("moments").op, transform: `translateY(${rev("moments").ty})`, transition: `opacity 0.9s ${EASE}, transform 0.9s ${EASE}` }}>
              {sectionRule("Moments", "a life in frames")}
            </div>
            <div style={{ display: "flex", gap: "clamp(16px,2vw,28px)", padding: "10px clamp(24px,6vw,100px) 24px", overflowX: "auto", scrollSnapType: "x proximity", opacity: rev("moments").op, transition: "opacity 1s ease 0.15s" }}>
              {MOMENTS.map((m) => (
                <figure key={m.src} className="cine-moment" style={{ flex: "0 0 auto", width: "clamp(260px, 30vw, 420px)", margin: m.offset ? "clamp(18px,3vh,34px) 0 0" : 0, scrollSnapAlign: "start" }}>
                  <PhotoSlot src={m.src} alt={m.alt} placeholderCaption={m.placeholderCaption} frame={{ width: "100%", height: "clamp(300px, 44vh, 440px)", borderRadius: 16, boxShadow: "0 16px 48px rgba(43,37,25,0.13)" }} />
                  <figcaption className="font-body" style={{ marginTop: 12, fontSize: 12, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "#9A8F7D" }}>{m.caption}</figcaption>
                </figure>
              ))}
              <div style={{ flex: "0 0 auto", width: "clamp(240px, 26vw, 360px)", display: "flex", alignItems: "center", padding: "0 clamp(12px,2vw,32px)" }}>
                <div>
                  <div aria-hidden style={{ width: 56, height: 1, background: "#C9A24B", marginBottom: 22 }} />
                  <p className="font-display" style={{ margin: 0, fontSize: "clamp(22px,2.6vw,34px)", fontStyle: "italic", fontWeight: 500, color: "#201B12", lineHeight: 1.35, textWrap: "pretty" }}>Every photograph is a moment he was teaching.</p>
                </div>
              </div>
            </div>
          </section>

          {/* ── MANIFESTO ── */}
          <section data-creveal="manifesto" style={{ padding: "clamp(80px,14vh,160px) clamp(24px,6vw,100px)", maxWidth: 1080, margin: "0 auto", width: "100%", boxSizing: "border-box", textAlign: "center" }}>
            <p className="font-display" style={{ margin: 0, fontSize: "clamp(32px, 4.8vw, 66px)", fontWeight: 600, lineHeight: 1.18, letterSpacing: "-0.02em", color: "#201B12", textWrap: "balance", opacity: rev("manifesto").op, transform: `translateY(${rev("manifesto").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>He wrote every word.<br />We only help you find them.</p>
            <p className="font-display" style={{ margin: "24px 0 0", fontSize: "clamp(18px, 2.2vw, 28px)", fontStyle: "italic", background: "linear-gradient(120deg, #C9A24B, #6B57C9)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", opacity: rev("manifesto").op, transition: "opacity 1s ease 0.3s" }}>Nothing added. Nothing invented.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "clamp(24px,3vw,44px)", marginTop: "clamp(48px,8vh,72px)", textAlign: "left" }}>
              {WHY.map((w, i) => (
                <div key={w.title} style={{ borderTop: "1px solid #D8CCB8", paddingTop: 20, opacity: rev("manifesto").op, transform: `translateY(${rev("manifesto").ty})`, transition: `opacity 0.9s ${EASE} ${0.25 + i * 0.15}s, transform 0.9s ${EASE} ${0.25 + i * 0.15}s` }}>
                  <p className="font-display" style={{ margin: "0 0 8px", fontSize: "clamp(20px,2.2vw,26px)", fontWeight: 600, color: "#201B12" }}>{w.title}</p>
                  <p className="font-body" style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: "#6E6353" }}>{w.body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── 1965 TEASER — sharp photograph, no blur ── */}
          <Link href="/journey" data-creveal="journey" className="cine-journey" style={{ textDecoration: "none", display: "block", position: "relative", minHeight: "clamp(420px, 68vh, 640px)", overflow: "hidden", cursor: "pointer" }}>
            <div ref={parallaxRef} role="img" aria-label="The Jaladuta, 1965" style={{ position: "absolute", inset: "-14% 0", backgroundImage: `url('${jaladutaReady ? JALADUTA : "/images/lockscreen/prabhupadaanddisciplessmiling.jpg"}')`, backgroundSize: "cover", backgroundPosition: "center 40%", willChange: "transform" }} />
            <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.30) 26%, rgba(22,18,12,0.38) 60%, rgba(22,18,12,0.78) 100%)" }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "60px 24px", opacity: rev("journey").op, transform: `translateY(${rev("journey").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
              <p className="font-display" style={{ margin: 0, fontSize: "clamp(80px, 14vw, 200px)", fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1, color: "rgba(255,248,232,0.95)", textShadow: "0 6px 60px rgba(22,18,12,0.5)" }}>1965</p>
              <p className="font-display" style={{ margin: "12px 0 0", fontSize: "clamp(20px, 2.8vw, 34px)", fontStyle: "italic", color: "rgba(255,248,232,0.92)", textWrap: "pretty", maxWidth: 640 }}>He crossed an ocean at sixty-nine.</p>
              <span className="cine-journey-btn font-body" style={{ display: "inline-flex", alignItems: "center", gap: 10, marginTop: 30, padding: "13px 32px", border: "1px solid rgba(255,244,214,0.45)", borderRadius: 100, color: "#FFF8E8", fontSize: 13, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", background: "rgba(22,18,12,0.25)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", transition: `all 0.4s ${EASE}` }}>
                The journey
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
            </div>
          </Link>

          {/* ── VOICES — honestly labelled samples ── */}
          <section data-creveal="voices" style={{ padding: "clamp(70px,11vh,130px) clamp(24px,6vw,100px)", maxWidth: 1280, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: "clamp(36px,5vh,56px)", opacity: rev("voices").op, transform: `translateY(${rev("voices").ty})`, transition: `opacity 0.9s ${EASE}, transform 0.9s ${EASE}` }}>
              <p className="font-body" style={{ margin: 0, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>From the devotees</p>
              <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
              <p className="font-body" style={{ margin: 0, fontSize: 12, fontWeight: 500, color: "#9A8F7D", whiteSpace: "nowrap" }}>Sample voices — real quotes coming</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "clamp(18px,2.5vw,28px)" }}>
              {VOICES.map((v, i) => (
                <figure key={v.who} style={{ margin: 0, background: "#FEFCF8", border: "1px solid #E8E0D2", borderRadius: 18, padding: "clamp(24px,3vw,34px)", boxShadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)", display: "flex", flexDirection: "column", gap: 18, opacity: rev("voices").op, transform: `translateY(${rev("voices").ty})`, transition: `opacity 0.9s ${EASE} ${0.15 + i * 0.15}s, transform 0.9s ${EASE} ${0.15 + i * 0.15}s` }}>
                  <blockquote className="font-display" style={{ margin: 0, fontSize: "clamp(16px,1.8vw,19px)", fontStyle: "italic", lineHeight: 1.55, color: "#2B2519", flex: 1 }}>&ldquo;{v.quote}&rdquo;</blockquote>
                  <figcaption>
                    <p className="font-body" style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: "#201B12" }}>{v.who}</p>
                    <p className="font-body" style={{ margin: "2px 0 0", fontSize: 12, color: "#9A8F7D" }}>Sample — a real voice will appear here</p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          {/* ── CLOSE — one quiet door back to the search ── */}
          <section data-creveal="cta" style={{ padding: "clamp(70px,12vh,140px) clamp(24px,6vw,100px) clamp(90px,14vh,160px)", textAlign: "center", opacity: rev("cta").op, transform: `translateY(${rev("cta").ty})`, transition: `opacity 1s ${EASE}, transform 1s ${EASE}` }}>
            <div aria-hidden style={{ width: 56, height: 1, background: "#C9A24B", margin: "0 auto 26px" }} />
            <h2 className="font-display" style={{ margin: "0 0 14px", fontSize: "clamp(32px,4.6vw,62px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#201B12", textWrap: "balance" }}>Ask your first question</h2>
            <p className="font-display" style={{ margin: "0 auto 30px", fontSize: "clamp(16px,2vw,21px)", fontStyle: "italic", color: "#6E6353", maxWidth: 480 }}>His words are waiting.</p>
            <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="cine-cta-btn font-body" style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", borderRadius: 100, padding: "16px 40px", fontSize: 15, fontWeight: 500, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "0 10px 34px rgba(107,87,201,0.30)", transition: `all 0.45s ${EASE}` }}>
              <span>Search the books</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </section>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
