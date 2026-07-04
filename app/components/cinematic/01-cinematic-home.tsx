/**
 * 01-cinematic-home.tsx — Cinematic Main Page (v2)
 *
 * A faithful React/Next.js port of the "Cinematic Main Page v2" Claude Design
 * prototype: a single continuous cinematic scroll made of a title-sequence
 * entrance, a breathing hero with an ambient search bar, the library count-up,
 * a pinned horizontal photo gallery, a per-word manifesto scrub, editorial
 * "why different" rows, a 1965 journey teaser, a rotating testimonial, and a
 * full-bleed CTA. It also owns the nav "More" menu, the cinematic Donate /
 * Feature-request / Feedback pop-ups, the floating feedback button, and an
 * optional ambient temple drone.
 *
 * Motion values, timings and copy are ported verbatim from the prototype;
 * colors reuse the design tokens in globals.css. Keyframes and :hover styling
 * live in the "CINEMATIC MAIN PAGE" block of globals.css.
 *
 * Search seam: submitting a question plays the meditative aura/mandala sequence
 * and then hands off to the app's search (see `runSearch`). Wire that call to
 * your real search handler when integrating; it currently deep-links to the
 * home route with `?q=` (the app's existing deep-link convention).
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

/* ─── Static content (verbatim from the prototype) ─── */

const IMG = {
  disciples: "/images/lockscreen/prabhupadaanddisciplessmiling.jpg",
  deities: "/images/lockscreen/Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg",
  walk: "/images/lockscreen/Srila-Prabhupada-on-morning-walk-in-Vrindavan-620x350.avif",
};

const DAILY_VERSES = [
  { text: "For one who has conquered the mind, the mind is the best of friends; but for one who has failed to do so, his mind will remain the greatest enemy.", citation: "Bhagavad Gītā 6.6" },
  { text: "For the soul there is neither birth nor death at any time. He has not come into being, does not come into being, and will not come into being.", citation: "Bhagavad Gītā 2.20" },
  { text: "In this endeavor there is no loss or diminution, and a little advancement on this path can protect one from the most dangerous type of fear.", citation: "Bhagavad Gītā 2.40" },
  { text: "Abandon all varieties of religion and just surrender unto Me. I shall deliver you from all sinful reactions. Do not fear.", citation: "Bhagavad Gītā 18.66" },
];

const EXAMPLE_QUESTIONS = [
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

const TESTIMONIALS = [
  { quote: "[FAKE] I use it every morning to trace a topic across Gītā, Bhāgavatam, and purports in under 5 minutes. It has completely transformed how I prepare for class.", name: "XXX", role: "Temple President · ISKCON AAA" },
  { quote: "[FAKE] It helps me prepare Bhāgavatam classes faster because I can verify the exact source immediately — no more flipping through six books to find one purport.", name: "BBB", role: "Bhakti-śāstrī Scholar" },
  { quote: "[FAKE] As a new devotee, it helped me study without relying on unsourced summaries. Every answer links back to Prabhupāda's actual words, so I know it's authentic.", name: "CCC", role: "Aspiring Devotee · 6 months" },
];

const SEARCH_STATUSES = ["Listening…", "Searching the library…", "Weaving his words…"];

const DONATE_INFO = [
  { label: "Account name", value: "Ask Śrīla Prabhupāda Seva" },
  { label: "Account number", value: "0000 0000 0000" },
  { label: "IFSC", value: "BANK0000000" },
  { label: "UPI", value: "seva@upi" },
];

const GALLERY = [
  { id: "gallery-1", img: IMG.deities, caption: "01 — Vṛndāvana", offset: false },
  { id: "gallery-2", img: IMG.disciples, caption: "02 — Teaching", offset: true },
  { id: "gallery-3", img: IMG.walk, caption: "03 — With disciples", offset: false },
  { id: "gallery-4", img: IMG.deities, caption: "04 — The books", offset: true },
];

const MANIFESTO_WORDS = [
  ["He", "wrote", "every", "word."],
  ["We", "only", "help", "you", "find", "them."],
];

type Modal = "donate" | "feature" | "feedback" | null;
type Mode = "auto" | "click" | "off";

interface Props {
  entranceMode?: Mode;
  showLetterbox?: boolean;
  filmGrain?: boolean;
  showMotes?: boolean;
  parallaxStrength?: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const GRAIN_URI =
  "data:image/svg+xml;utf8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27160%27%20height=%27160%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%270.9%27%20numOctaves=%272%27%20stitchTiles=%27stitch%27/%3E%3CfeColorMatrix%20type=%27matrix%27%20values=%270%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200.55%200%27/%3E%3C/filter%3E%3Crect%20width=%27160%27%20height=%27160%27%20filter=%27url(%23n)%27/%3E%3C/svg%3E";

export default function CinematicHome({
  entranceMode = "click",
  showLetterbox = true,
  filmGrain = true,
  showMotes = true,
  parallaxStrength = 1,
}: Props) {
  /* ── state ── */
  const [beat, setBeat] = useState(0);
  const [lockVisible, setLockVisible] = useState(true);
  const [lockMounted, setLockMounted] = useState(true);
  const [heroIn, setHeroIn] = useState(false);
  const [verseIdx, setVerseIdx] = useState(0);
  const [twText, setTwText] = useState("");
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [stats, setStats] = useState({ books: 0, lectures: 0, letters: 0 });
  const [tIdx, setTIdx] = useState(0);
  const [tVisible, setTVisible] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchPhase, setSearchPhase] = useState(0);
  const [searchQ, setSearchQ] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [navMoreOpen, setNavMoreOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [featText, setFeatText] = useState("");
  const [featEmail, setFeatEmail] = useState("");
  const [featSent, setFeatSent] = useState(false);
  const [fbVote, setFbVote] = useState<"up" | "down" | null>(null);
  const [fbText, setFbText] = useState("");
  const [fbSent, setFbSent] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [footerNear, setFooterNear] = useState(false);
  const [motes, setMotes] = useState<React.CSSProperties[]>([]);

  /* ── refs (for stable access inside long-lived listeners) ── */
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrolledRef = useRef(false);
  const focusedRef = useRef(false);
  const queryRef = useRef("");
  const lockVisibleRef = useRef(true);
  const footerNearRef = useRef(false);
  const audioRef = useRef<{ ctx: AudioContext; master: GainNode } | null>(null);
  const searchIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tRotRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRafRef = useRef<number>(0);
  const plRafRef = useRef<number>(0);

  useEffect(() => { scrolledRef.current = scrolled; }, [scrolled]);
  useEffect(() => { focusedRef.current = focused; }, [focused]);
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { lockVisibleRef.current = lockVisible; }, [lockVisible]);
  useEffect(() => { footerNearRef.current = footerNear; }, [footerNear]);

  const pushTimer = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timersRef.current.push(t);
    return t;
  }, []);

  /* ── entrance dismiss (camera pull → hero) ── */
  const dismiss = useCallback(() => {
    if (!lockVisibleRef.current) return;
    lockVisibleRef.current = false;
    setLockVisible(false);
    setHeroIn(true);
    pushTimer(() => setLockMounted(false), 1200);
  }, [pushTimer]);

  /* ── ambient sound (WebAudio drone) ── */
  const startDrone = useCallback(() => {
    if (audioRef.current) return;
    try {
      const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtor();
      const master = ctx.createGain(); master.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 340; lp.Q.value = 0.4;
      lp.connect(master); master.connect(ctx.destination);
      const mk = (type: OscillatorType, freq: number, g: number) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
        const og = ctx.createGain(); og.gain.value = g;
        o.connect(og); og.connect(lp); o.start();
        return o;
      };
      // oscillators are retained by the live audio graph; no need to store them
      mk("sine", 110, 0.5); mk("sine", 110.7, 0.42); mk("sine", 220.4, 0.16); mk("triangle", 55, 0.34); mk("sine", 660.2, 0.02);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.012;
      lfo.connect(lfoG); lfoG.connect(master.gain); lfo.start();
      master.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 2.5);
      audioRef.current = { ctx, master };
    } catch { /* audio unavailable */ }
  }, []);

  const stopDrone = useCallback(() => {
    if (!audioRef.current) return;
    const { ctx, master } = audioRef.current;
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
      setTimeout(() => { try { ctx.close(); } catch { /* ok */ } }, 900);
    } catch { /* ok */ }
    audioRef.current = null;
  }, []);

  const toggleSound = useCallback((e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSoundOn((prev) => {
      const on = !prev;
      try { localStorage.setItem("asp_sound", on ? "on" : "off"); } catch { /* ok */ }
      if (on) startDrone(); else stopDrone();
      return on;
    });
  }, [startDrone, stopDrone]);

  /* ── count-up for library stats ── */
  const countUp = useCallback(() => {
    const start = performance.now(), dur = 2400;
    const targets = { books: 36, lectures: 3700, letters: 6500 };
    const step = (now: number) => {
      const p = Math.min((now - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setStats({
        books: Math.round(e * targets.books),
        lectures: Math.round(e * targets.lectures),
        letters: Math.round(e * targets.letters),
      });
      if (p < 1) countRafRef.current = requestAnimationFrame(step);
    };
    countRafRef.current = requestAnimationFrame(step);
  }, []);

  /* ── cinematic search moment → hand off to search ── */
  const runSearch = useCallback((q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchPhase(0);
    setSearchQ(q.trim());
    let phase = 0;
    searchIvRef.current = setInterval(() => {
      phase += 1;
      if (phase >= 3) {
        if (searchIvRef.current) clearInterval(searchIvRef.current);
        // Integration seam: the cinematic moment hands off to the woven-answer
        // results page. Point this at your real search route when integrating.
        window.location.assign("/search?q=" + encodeURIComponent(q.trim()));
        return;
      }
      setSearchPhase(phase);
    }, 1150);
  }, []);

  /* ── mount: entrance sequence, scroll engine, observers, rotators ── */
  useEffect(() => {
    // random daily verse (client-only, avoids hydration mismatch)
    setVerseIdx(Math.floor(Math.random() * DAILY_VERSES.length));

    // drifting motes
    if (showMotes) {
      const rand = (a: number, b: number) => a + Math.random() * (b - a);
      setMotes(
        Array.from({ length: 26 }, (_, i) => {
          const gold = i % 3 === 0;
          const size = rand(3, 7);
          return {
            position: "absolute",
            left: rand(4, 96) + "%",
            bottom: rand(-10, 40) + "%",
            width: size,
            height: size,
            borderRadius: "50%",
            background: gold ? "rgba(201,162,75,0.72)" : "rgba(139,110,224,0.62)",
            filter: "blur(" + rand(0.5, 2.2) + "px)",
            "--mx": rand(-60, 60) + "px",
            "--mo": rand(0.4, 0.8),
            animation: "moteDrift " + rand(9, 20).toFixed(1) + "s linear " + rand(0, 12).toFixed(1) + "s infinite",
            pointerEvents: "none",
          } as React.CSSProperties;
        }),
      );
    }

    // entrance mode — a "Now, ask him" (#ask / ?ask) or deep-link (?q=) skips the film
    let mode: Mode = entranceMode;
    let askFlag = false;
    let qParam = "";
    try {
      askFlag = /(^|[#?&])ask(=|$|&)/i.test(location.hash + location.search);
      qParam = new URLSearchParams(location.search).get("q") || "";
    } catch { /* ok */ }
    if (askFlag || qParam) mode = "off";

    if (mode === "off") {
      lockVisibleRef.current = false;
      setLockVisible(false);
      setLockMounted(false);
      setHeroIn(true);
      setBeat(3);
      if (qParam) setQuery(qParam);
      pushTimer(() => {
        try {
          window.scrollTo({ top: 0 });
          textareaRef.current?.focus();
        } catch { /* ok */ }
      }, 60);
    } else {
      pushTimer(() => setBeat(1), 200);   // verse on black
      pushTimer(() => setBeat(2), 2600);  // photo bloom
      pushTimer(() => setBeat(3), 3600);  // title reveal
      if (mode === "auto") pushTimer(() => dismiss(), 7400);
      else pushTimer(() => setBeat(4), 5400); // enter button (click mode)
    }

    // typewriter placeholder
    let twQ = 0, twChar = 0, twPhase: "typing" | "pausing" | "erasing" = "typing";
    const twRun = () => {
      if (focusedRef.current || queryRef.current) { timersRef.current.push(setTimeout(twRun, 400)); return; }
      const q = TW_QUESTIONS[twQ % TW_QUESTIONS.length];
      if (twPhase === "typing") {
        if (twChar < q.length) { twChar++; setTwText(q.slice(0, twChar)); timersRef.current.push(setTimeout(twRun, 50)); }
        else { twPhase = "pausing"; timersRef.current.push(setTimeout(twRun, 3000)); }
      } else if (twPhase === "pausing") { twPhase = "erasing"; timersRef.current.push(setTimeout(twRun, 0)); }
      else {
        if (twChar > 0) { twChar--; setTwText(q.slice(0, twChar)); timersRef.current.push(setTimeout(twRun, 25)); }
        else { twQ++; twPhase = "typing"; timersRef.current.push(setTimeout(twRun, 200)); }
      }
    };
    twRun();

    // header scroll state
    const onScroll = () => {
      const sc = window.scrollY > 20;
      if (sc !== scrolledRef.current) { scrolledRef.current = sc; setScrolled(sc); }
    };
    window.addEventListener("scroll", onScroll);

    // rAF engine: parallax bands + pinned scenes (direct DOM = 60fps, no re-render)
    const strength = () => parallaxStrength;
    const loop = () => {
      const root = rootRef.current;
      const vh = window.innerHeight;
      if (root) {
        root.querySelectorAll<HTMLElement>("[data-parallax]").forEach((el) => {
          const f = parseFloat(el.getAttribute("data-parallax") || "0") * strength();
          const parent = el.parentElement;
          if (!parent) return;
          const r = parent.getBoundingClientRect();
          const centerDelta = r.top + r.height / 2 - vh / 2;
          el.style.transform = "translateY(" + (-centerDelta * f).toFixed(1) + "px)";
        });
        root.querySelectorAll<HTMLElement>("[data-pin]").forEach((pin) => {
          const r = pin.getBoundingClientRect();
          const total = r.height - vh;
          if (total <= 0) return;
          const p = clamp01(-r.top / total);
          const name = pin.getAttribute("data-pin");
          if (name === "hgallery") {
            const track = pin.querySelector<HTMLElement>("[data-htrack]");
            if (track) {
              const overflow = track.scrollWidth - window.innerWidth;
              if (overflow > 0) track.style.transform = "translateX(" + (-p * overflow).toFixed(1) + "px)";
            }
          } else if (name === "manifesto") {
            const words = pin.querySelectorAll<HTMLElement>("[data-word]");
            const n = words.length;
            words.forEach((w, i) => {
              const on = p * (n + 2) > i + 0.6;
              w.style.opacity = on ? "1" : "0.1";
              w.style.filter = on ? "blur(0px)" : "blur(5px)";
            });
            const tail = pin.querySelector<HTMLElement>("[data-manifesto-tail]");
            if (tail) {
              const on = p > 0.72;
              tail.style.opacity = on ? "1" : "0";
              tail.style.transform = on ? "translateY(0)" : "translateY(14px)";
            }
          }
        });
      }
      plRafRef.current = requestAnimationFrame(loop);
    };
    plRafRef.current = requestAnimationFrame(loop);

    // reveal-on-scroll + footer proximity (feedback button bows out over the footer)
    let io: IntersectionObserver | null = null;
    let footIo: IntersectionObserver | null = null;
    const setupObservers = pushTimer(() => {
      const root = rootRef.current;
      if (!root) return;
      io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const key = entry.target.getAttribute("data-creveal");
            if (key) {
              setRevealed((s) => ({ ...s, [key]: true }));
              if (key === "lib") countUp();
            }
            io?.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: "0px 0px -60px 0px" });
      root.querySelectorAll("[data-creveal]").forEach((el) => io?.observe(el));

      footIo = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting !== footerNearRef.current) {
            footerNearRef.current = en.isIntersecting;
            setFooterNear(en.isIntersecting);
          }
        });
      }, { threshold: 0.05 });
      const foot = root.querySelector("footer");
      if (foot) footIo.observe(foot);
    }, 400);

    // testimonial rotation
    tRotRef.current = setInterval(() => {
      setTVisible(false);
      pushTimer(() => {
        setTIdx((i) => (i + 1) % TESTIMONIALS.length);
        setTVisible(true);
      }, 600);
    }, 7000);

    // keyboard: Enter/Space to enter, Escape to close
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && lockVisibleRef.current) dismiss();
      if (e.key === "Escape") { setModal(null); setNavMoreOpen(false); setMoreOpen(false); }
    };
    window.addEventListener("keydown", onKey);

    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(setupObservers);
      cancelAnimationFrame(countRafRef.current);
      cancelAnimationFrame(plRafRef.current);
      io?.disconnect();
      footIo?.disconnect();
      if (tRotRef.current) clearInterval(tRotRef.current);
      if (searchIvRef.current) clearInterval(searchIvRef.current);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      stopDrone();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── derived render values ── */
  const rev = (k: string) => (revealed[k] ? { op: 1, ty: "0px" } : { op: 0, ty: "40px" });
  const can = query.trim().length > 0;
  const verse = DAILY_VERSES[verseIdx];
  const t = TESTIMONIALS[tIdx];

  const b = {
    verseOp: beat === 1 ? 1 : 0,
    verseY: beat < 1 ? "18px" : beat > 1 ? "-24px" : "0px",
    imgOp: beat >= 2 ? 1 : 0,
  };
  const bars = !showLetterbox || !lockVisible
    ? { top: "-100%", bottom: "100%" }
    : beat >= 2 ? { top: "0", bottom: "0" } : { top: "-100%", bottom: "100%" };
  const ti = beat >= 3
    ? { l1: "0", l2: "0", rule: "120px", tagOp: 1, btnOp: beat >= 4 ? 1 : 0, btnY: beat >= 4 ? "0px" : "12px" }
    : { l1: "110%", l2: "110%", rule: "0px", tagOp: 0, btnOp: 0, btnY: "12px" };
  const showEnterBtn = entranceMode === "click" && beat >= 4;

  const lock = lockVisible ? { op: 1, pe: "auto" as const, contentY: "0px" } : { op: 0, pe: "none" as const, contentY: "-60px" };
  const main = lockVisible ? { op: 0, scale: 0.97 } : { op: 1, scale: 1 };
  const hr = heroIn
    ? { l1: "0", l2: "0", l3: "0", formOp: 1, formY: "0px" }
    : { l1: "110%", l2: "110%", l3: "110%", formOp: 0, formY: "28px" };

  const hdr = scrolled
    ? { bg: "linear-gradient(120deg, rgba(254,252,248,0.94), rgba(250,247,241,0.90))", border: "#E8E0D2", shadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)" }
    : { bg: "linear-gradient(120deg, rgba(254,252,248,0.82), rgba(250,247,241,0.74))", border: "transparent", shadow: "none" };

  const soundWaveOp = soundOn ? 1 : 0.25;
  const soundColor = soundOn ? "#6B57C9" : "#9A8F7D";
  const wrapFrom = focused ? "rgba(107,87,201,0.72)" : "rgba(107,87,201,0.40)";
  const wrapTo = focused ? "rgba(201,162,75,0.5)" : "rgba(201,162,75,0.26)";
  const wrapGlow = focused
    ? "0 0 0 4px rgba(107,87,201,0.10), 0 18px 60px rgba(107,87,201,0.16)"
    : "0 2px 6px rgba(43,37,25,0.05), 0 18px 50px rgba(43,37,25,0.08)";

  const mandala = useMemo(() => Array.from({ length: 12 }, (_, i) => i * 30), []);

  const pick = (text: string) => () => { setQuery(text); setFocused(true); };
  const focusSearch = () => {
    dismiss();
    pushTimer(() => { window.scrollTo({ top: 0, behavior: "smooth" }); textareaRef.current?.focus(); }, 80);
  };
  const copyRow = (label: string, value: string) => () => {
    try { navigator.clipboard.writeText(value); } catch { /* ok */ }
    setCopied(label);
    pushTimer(() => setCopied(null), 1600);
  };

  /* ── shared style fragments ── */
  const overlayBackdrop: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center",
    padding: "clamp(20px,5vw,60px)",
    background: "radial-gradient(120% 100% at 50% 30%, rgba(45,36,80,0.42), rgba(22,18,12,0.66))",
    backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)",
    animation: "moreOverlayIn 0.5s ease both",
  };
  const overlayPanel = (maxWidth: number): React.CSSProperties => ({
    position: "relative", width: "100%", maxWidth, maxHeight: "88vh", overflowY: "auto",
    padding: "clamp(30px,4vw,46px)", borderRadius: 28,
    background: "linear-gradient(160deg, rgba(254,252,248,0.98), rgba(250,247,241,0.96))",
    border: "1px solid rgba(255,255,255,0.6)",
    boxShadow: "0 40px 120px rgba(22,18,12,0.5), 0 0 0 1px rgba(107,87,201,0.08)",
    animation: "morePanelIn 0.7s cubic-bezier(0.16,1,0.3,1) both",
  });
  const closeBtn = (
    <button onClick={() => setModal(null)} aria-label="Close" className="cine-close"
      style={{ position: "absolute", top: 16, right: 16, width: 38, height: 38, borderRadius: "50%", border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  );
  const eyebrow = (color: string): React.CSSProperties => ({
    fontSize: 11, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color, textAlign: "center",
  });

  const featDisabled = !featText.trim();
  const fbDisabled = !fbVote && !fbText.trim();

  return (
    <div ref={rootRef}>
      {/* ── FILM GRADE: vignette (under UI) + animated grain (over everything) ── */}
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none", background: "radial-gradient(120% 100% at 50% 42%, transparent 58%, rgba(22,18,12,0.14) 100%)" }} />
      {filmGrain && (
        <div aria-hidden style={{ position: "fixed", inset: "-12%", zIndex: 3000, pointerEvents: "none", opacity: 0.05, backgroundImage: `url('${GRAIN_URI}')`, backgroundSize: "160px 160px", animation: "grainShift 0.9s steps(1) infinite" }} />
      )}

      {/* ═══════════ ENTRANCE — title sequence ═══════════ */}
      {lockMounted && (
        <div role="button" tabIndex={0} aria-label="Enter the site" onClick={dismiss}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#16120C", cursor: "pointer", overflow: "hidden", opacity: lock.op, transition: "opacity 1.1s cubic-bezier(0.4,0,0.2,1)", pointerEvents: lock.pe }}>

          {/* Beat 1: verse alone on black */}
          <div style={{ position: "absolute", inset: 0, zIndex: 3, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", textAlign: "center", opacity: b.verseOp, transform: `translateY(${b.verseY})`, transition: "opacity 1.4s ease, transform 1.6s cubic-bezier(0.16,1,0.3,1)", pointerEvents: "none" }}>
            <p className="font-display" style={{ maxWidth: 680, fontSize: "clamp(1.15rem, 2.6vw, 1.7rem)", fontStyle: "italic", color: "rgba(255,248,232,0.94)", lineHeight: 1.65, textWrap: "pretty" }}>“{verse.text}”</p>
            <span className="font-body" style={{ marginTop: 18, fontSize: 12, fontWeight: 600, color: "rgba(201,162,75,0.95)", letterSpacing: "0.26em", textTransform: "uppercase" }}>{verse.citation}</span>
          </div>

          {/* Beat 2: photo blooms in */}
          <div style={{ position: "absolute", inset: 0, backgroundImage: `url('${IMG.disciples}')`, backgroundSize: "cover", backgroundPosition: "center 30%", animation: "cineKenBurns 26s cubic-bezier(0.25,0,0.4,1) forwards", transformOrigin: "50% 38%", opacity: b.imgOp, transition: "opacity 2.0s cubic-bezier(0.4,0,0.2,1)" }} />
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(22,18,12,0.34) 0%, rgba(22,18,12,0.06) 34%, rgba(22,18,12,0.12) 60%, rgba(22,18,12,0.74) 100%)", opacity: b.imgOp, transition: "opacity 2.0s ease" }} />
          <div style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 50% 88%, rgba(201,162,75,0.22), transparent 55%)", opacity: b.imgOp, transition: "opacity 2.4s ease" }} />
          <div aria-hidden style={{ position: "absolute", top: "-30%", left: 0, width: "45%", height: "160%", background: "linear-gradient(90deg, transparent, rgba(255,244,214,0.20), transparent)", filter: "blur(30px)", animation: "lightSweep 9s ease-in-out infinite", pointerEvents: "none", opacity: b.imgOp }} />

          {/* Letterbox bars */}
          <div aria-hidden style={{ position: "absolute", top: 0, left: 0, right: 0, height: "7vh", background: "#16120C", zIndex: 4, transform: `translateY(${bars.top})`, transition: "transform 1.3s cubic-bezier(0.65,0,0.35,1)" }} />
          <div aria-hidden style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "7vh", background: "#16120C", zIndex: 4, transform: `translateY(${bars.bottom})`, transition: "transform 1.3s cubic-bezier(0.65,0,0.35,1)" }} />

          <button onClick={(e) => { e.stopPropagation(); dismiss(); }} aria-label="Skip intro" className="cine-skip"
            style={{ position: "absolute", top: "calc(7vh + 14px)", right: 22, zIndex: 5, background: "rgba(22,18,12,0.25)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,244,214,0.25)", borderRadius: 100, color: "rgba(255,248,232,0.85)", fontSize: 12, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", cursor: "pointer", padding: "7px 16px", transition: "all 0.3s ease" }}>Skip</button>

          {/* Sound toggle */}
          <button onClick={toggleSound} aria-label="Toggle ambient sound" className="cine-sound-btn"
            style={{ position: "absolute", bottom: "calc(7vh + 16px)", left: 22, zIndex: 5, display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(22,18,12,0.25)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,244,214,0.25)", borderRadius: 100, color: "rgba(255,248,232,0.85)", fontSize: 11, fontWeight: 500, letterSpacing: "0.10em", textTransform: "uppercase", cursor: "pointer", padding: "8px 16px", transition: "all 0.3s ease" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" opacity={soundWaveOp} /></svg>
            <span>{soundOn ? "Sound on" : "Sound off"}</span>
          </button>

          {/* Beat 3: title reveal */}
          <div style={{ position: "relative", zIndex: 3, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", padding: "0 24px 15vh", textAlign: "center", transform: `translateY(${lock.contentY})`, transition: "transform 1.1s cubic-bezier(0.4,0,0.2,1)" }}>
            <div style={{ overflow: "hidden", padding: "2px 0" }}>
              <p className="font-body" style={{ fontSize: "clamp(11px,1.3vw,14px)", fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "rgba(255,244,214,0.85)", transform: `translateY(${ti.l1})`, transition: "transform 1.0s cubic-bezier(0.16,1,0.3,1) 0.1s", marginLeft: "0.42em" }}>Ask</p>
            </div>
            <div style={{ overflow: "hidden", padding: "6px 0 10px" }}>
              <h1 className="font-display" style={{ fontSize: "clamp(3rem, 10vw, 8.2rem)", fontWeight: 600, color: "#FFF8E8", letterSpacing: "-0.02em", lineHeight: 1.02, textShadow: "0 4px 44px rgba(22,18,12,0.45)", transform: `translateY(${ti.l2})`, transition: "transform 1.15s cubic-bezier(0.16,1,0.3,1) 0.3s" }}>Śrīla Prabhupāda</h1>
            </div>
            <div aria-hidden style={{ width: ti.rule, maxWidth: 120, height: 1, background: "linear-gradient(90deg, transparent, rgba(201,162,75,0.9), transparent)", margin: "10px auto 16px", transition: "width 1.4s cubic-bezier(0.16,1,0.3,1) 0.7s" }} />
            <p className="font-body" style={{ fontSize: "clamp(12px,1.4vw,14px)", fontWeight: 500, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,248,232,0.75)", opacity: ti.tagOp, transition: "opacity 1.2s ease 0.9s" }}>His words. Nothing else.</p>
            {showEnterBtn && (
              <div style={{ marginTop: 34, opacity: ti.btnOp, transform: `translateY(${ti.btnY})`, transition: "opacity 0.9s ease 0.2s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.2s" }}>
                <button onClick={(e) => { e.stopPropagation(); dismiss(); }} aria-label="Enter" className="cine-enter-btn"
                  style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "rgba(255,248,232,0.12)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", color: "#FFF8E8", border: "1px solid rgba(255,244,214,0.45)", borderRadius: 100, padding: "14px 36px", fontSize: 14, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer", transition: "all 0.45s cubic-bezier(0.16,1,0.3,1)" }}>
                  <span>Enter</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ SEARCH MOMENT OVERLAY ═══════════ */}
      {searching && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(250,247,241,0.94)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ position: "relative", width: "min(70vw, 340px)", height: "min(70vw, 340px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div aria-hidden style={{ position: "absolute", top: "50%", left: "50%", width: "130%", height: "130%", borderRadius: "50%", background: "radial-gradient(circle, rgba(139,110,224,0.26) 0%, rgba(201,162,75,0.12) 42%, transparent 70%)", filter: "blur(38px)", animation: "auraBreathe 4.5s ease-in-out infinite" }} />
            <svg viewBox="0 0 400 400" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.16, animation: "rotateMandala 60s linear infinite", color: "#6B57C9" }}>
              {mandala.map((deg, i) => (
                <g key={i} transform={`rotate(${deg} 200 200)`}><ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.6" /></g>
              ))}
              <circle cx="200" cy="200" r="70" fill="none" stroke="currentColor" strokeWidth="0.5" />
              <circle cx="200" cy="200" r="110" fill="none" stroke="currentColor" strokeWidth="0.35" />
            </svg>
            <p className="font-display" style={{ fontSize: "clamp(17px, 2.4vw, 22px)", fontStyle: "italic", color: "#51409A", textAlign: "center", maxWidth: 240, position: "relative" }}>{SEARCH_STATUSES[searchPhase]}</p>
          </div>
          <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 10, maxWidth: 420, textAlign: "center" }}>“{searchQ}”</p>
          <div style={{ width: "min(60vw, 280px)", height: 2, background: "#E8E0D2", borderRadius: 2, marginTop: 28, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${((searchPhase + 1) / 3 * 100).toFixed(0)}%`, background: "linear-gradient(90deg, #C9A24B, #6B57C9)", borderRadius: 2, transition: "width 1.1s cubic-bezier(0.2,0,0,1)" }} />
          </div>
        </div>
      )}

      {/* ═══════════ MORE QUESTIONS — cinematic overlay ═══════════ */}
      {moreOpen && (
        <div role="dialog" aria-label="Example questions" onClick={() => setMoreOpen(false)}
          style={{ ...overlayBackdrop, background: "radial-gradient(120% 100% at 50% 30%, rgba(45,36,80,0.42), rgba(22,18,12,0.66))", backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...overlayPanel(760), maxWidth: 760, maxHeight: "86vh", padding: "clamp(32px,4vw,52px)", border: "1px solid rgba(255,255,255,0.6)", boxShadow: "0 40px 120px rgba(22,18,12,0.5), 0 0 0 1px rgba(107,87,201,0.08)" }}>
            <button onClick={() => setMoreOpen(false)} aria-label="Close" className="cine-close" style={{ position: "absolute", top: 18, right: 18, width: 38, height: 38, borderRadius: "50%", border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <p className="font-body" style={eyebrow("#6B57C9")}>Ask him anything</p>
            <h2 className="font-display" style={{ fontSize: "clamp(26px,3.4vw,40px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>Where would you like to begin?</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,19px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: "clamp(26px,3vh,36px)" }}>Choose a question — his own words will answer.</p>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
              {EXAMPLE_QUESTIONS.map((q, i) => (
                <button key={q} className="cine-overlay-pill font-body"
                  onClick={() => { setQuery(q); setFocused(true); setMoreOpen(false); }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "11px 20px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", fontSize: 14, fontWeight: 400, color: "#2B2519", cursor: "pointer", whiteSpace: "nowrap", opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) both", animationDelay: `${(0.14 + i * 0.05).toFixed(2)}s`, transition: "background 0.3s, border-color 0.3s, color 0.3s, box-shadow 0.3s, transform 0.3s" }}>{q}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Nav "More" click-away backdrop */}
      {navMoreOpen && <div onClick={() => setNavMoreOpen(false)} aria-hidden style={{ position: "fixed", inset: 0, zIndex: 99, cursor: "default" }} />}

      {/* ═══════════ DONATE — cinematic overlay ═══════════ */}
      {modal === "donate" && (
        <div role="dialog" aria-label="Donate" onClick={() => setModal(null)} style={overlayBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={overlayPanel(520)}>
            {closeBtn}
            <p className="font-body" style={eyebrow("#C9A24B")}>Support the seva</p>
            <h2 className="font-display" style={{ fontSize: "clamp(24px,3vw,34px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>Keep his words freely searchable</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,18px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: 24 }}>No ads. No fees. Only seva.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {DONATE_INFO.map((d, i) => (
                <div key={d.label} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", padding: "12px 16px", border: "1px solid #E8E0D2", borderRadius: 14, background: "rgba(254,252,248,0.9)", opacity: 0, animation: "moreCardIn 0.55s cubic-bezier(0.16,1,0.3,1) both", animationDelay: `${(0.14 + i * 0.06).toFixed(2)}s` }}>
                  <div style={{ minWidth: 0 }}>
                    <p className="font-body" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.22em", textTransform: "uppercase", color: "#C9A24B" }}>{d.label}</p>
                    <p className="font-body" style={{ fontSize: 15, fontWeight: 500, color: "#2B2519", marginTop: 3, fontVariantNumeric: "tabular-nums", overflowWrap: "break-word" }}>{d.value}</p>
                  </div>
                  <button onClick={copyRow(d.label, d.value)} className="cine-copy-btn font-body" style={{ padding: "7px 14px", borderRadius: 100, border: "1px solid rgba(107,87,201,0.3)", background: "rgba(107,87,201,0.06)", color: "#51409A", fontSize: 12, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.3s" }}>{copied === d.label ? "Copied" : "Copy"}</button>
                </div>
              ))}
            </div>
            <p className="font-body" style={{ fontSize: 12, color: "#9A8F7D", textAlign: "center", marginTop: 18 }}>Every contribution keeps the library online — servers, search, nothing else.</p>
          </div>
        </div>
      )}

      {/* ═══════════ FEATURE REQUEST — cinematic overlay ═══════════ */}
      {modal === "feature" && (
        <div role="dialog" aria-label="Feature request" onClick={() => setModal(null)} style={overlayBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={overlayPanel(520)}>
            {closeBtn}
            <p className="font-body" style={eyebrow("#C9A24B")}>Shape what comes next</p>
            <h2 className="font-display" style={{ fontSize: "clamp(24px,3vw,34px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>What would serve your study?</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,18px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: 24 }}>Describe it — we read every request.</p>
            {!featSent ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.15s both" }}>
                <textarea value={featText} onChange={(e) => setFeatText(e.target.value)} placeholder="The feature you wish existed…" rows={4} aria-label="Feature request" className="cine-field font-body" style={{ width: "100%", display: "block", padding: "14px 16px", fontSize: 14, border: "1px solid #E8E0D2", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none", resize: "none", lineHeight: 1.6, transition: "border-color 0.3s" }} />
                <input value={featEmail} onChange={(e) => setFeatEmail(e.target.value)} placeholder="Email (optional — for updates)" aria-label="Email" className="cine-field font-body" style={{ width: "100%", display: "block", padding: "13px 16px", fontSize: 14, border: "1px solid #E8E0D2", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none", transition: "border-color 0.3s" }} />
                <button onClick={() => { if (featText.trim()) setFeatSent(true); }} disabled={featDisabled} className="cine-send-btn font-body" style={{ alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 9, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", borderRadius: 100, padding: "13px 34px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", cursor: featDisabled ? "default" : "pointer", opacity: featDisabled ? 0.45 : 1, boxShadow: "0 10px 30px rgba(107,87,201,0.3)", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)", marginTop: 6 }}>Send request</button>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "18px 0 6px", animation: "moreCardIn 0.7s cubic-bezier(0.16,1,0.3,1) both" }}>
                <div aria-hidden style={{ width: 56, height: 1, background: "linear-gradient(90deg, transparent, #C9A24B, transparent)", margin: "0 auto 18px" }} />
                <p className="font-display" style={{ fontSize: 24, fontStyle: "italic", color: "#201B12" }}>Received with gratitude.</p>
                <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 8 }}>Every request is read. Hare Kṛṣṇa.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ FEEDBACK — cinematic overlay ═══════════ */}
      {modal === "feedback" && (
        <div role="dialog" aria-label="Feedback" onClick={() => setModal(null)} style={overlayBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={overlayPanel(520)}>
            {closeBtn}
            <p className="font-body" style={eyebrow("#C9A24B")}>From the heart</p>
            <h2 className="font-display" style={{ fontSize: "clamp(24px,3vw,34px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>How was your experience?</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,18px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: 24 }}>Your words guide ours.</p>
            {!fbSent ? (
              <>
                <div style={{ display: "flex", justifyContent: "center", gap: 12, opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.12s both" }}>
                  <button onClick={() => setFbVote("up")} className="cine-vote-btn font-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 140, padding: "18px 12px", borderRadius: 18, border: `1px solid ${fbVote === "up" ? "#6B57C9" : "#E8E0D2"}`, background: fbVote === "up" ? "rgba(107,87,201,0.10)" : "rgba(254,252,248,0.9)", color: fbVote === "up" ? "#51409A" : "#6E6353", cursor: "pointer", fontSize: 13, fontWeight: 500, transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)" }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /></svg>
                    <span>Helpful</span>
                  </button>
                  <button onClick={() => setFbVote("down")} className="cine-vote-btn font-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 140, padding: "18px 12px", borderRadius: 18, border: `1px solid ${fbVote === "down" ? "#6B57C9" : "#E8E0D2"}`, background: fbVote === "down" ? "rgba(107,87,201,0.10)" : "rgba(254,252,248,0.9)", color: fbVote === "down" ? "#51409A" : "#6E6353", cursor: "pointer", fontSize: 13, fontWeight: 500, transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)" }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" /></svg>
                    <span>Could be better</span>
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14, opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.2s both" }}>
                  <textarea value={fbText} onChange={(e) => setFbText(e.target.value)} placeholder="Tell us more (optional)…" rows={3} aria-label="Feedback" className="cine-field font-body" style={{ width: "100%", display: "block", padding: "14px 16px", fontSize: 14, border: "1px solid #E8E0D2", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none", resize: "none", lineHeight: 1.6, transition: "border-color 0.3s" }} />
                  <button onClick={() => { if (fbVote || fbText.trim()) setFbSent(true); }} disabled={fbDisabled} className="cine-send-btn font-body" style={{ alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 9, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", borderRadius: 100, padding: "13px 34px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", cursor: fbDisabled ? "default" : "pointer", opacity: fbDisabled ? 0.45 : 1, boxShadow: "0 10px 30px rgba(107,87,201,0.3)", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)" }}>Send feedback</button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "18px 0 6px", animation: "moreCardIn 0.7s cubic-bezier(0.16,1,0.3,1) both" }}>
                <div aria-hidden style={{ width: 56, height: 1, background: "linear-gradient(90deg, transparent, #C9A24B, transparent)", margin: "0 auto 18px" }} />
                <p className="font-display" style={{ fontSize: 24, fontStyle: "italic", color: "#201B12" }}>Thank you.</p>
                <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 8 }}>Received with gratitude. Hare Kṛṣṇa.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ HEADER (fixed, outside the camera-pull transform) ═══════════ */}
      <header style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, height: 60, background: hdr.bg, backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)", borderBottom: `1px solid ${hdr.border}`, padding: "0 clamp(20px,4vw,48px)", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: hdr.shadow, opacity: main.op, transition: "border-color 0.4s, background 0.4s, box-shadow 0.4s, opacity 0.8s ease 0.35s" }}>
        <button onClick={focusSearch} className="font-display" style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "clamp(1rem, 3.5vw, 1.4rem)", fontWeight: 600, color: "#51409A", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>Ask Śrīla Prabhupāda</button>
        <nav style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={focusSearch} className="font-body" style={{ display: "inline-flex", alignItems: "center", padding: "7px 16px", borderRadius: 9, fontSize: 14, fontWeight: 500, background: "rgba(107,87,201,0.16)", color: "#51409A", lineHeight: 1, whiteSpace: "nowrap", border: "none", cursor: "pointer" }}>Search</button>
          <Link href="/journey" className="cine-nav-link font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", padding: "7px 16px", borderRadius: 9, fontSize: 14, fontWeight: 400, background: "transparent", color: "#6E6353", lineHeight: 1, whiteSpace: "nowrap", transition: "color 0.3s" }}>His Journey</Link>
          <Link href="/features" className="cine-nav-link font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", padding: "7px 16px", borderRadius: 9, fontSize: 14, fontWeight: 400, background: "transparent", color: "#6E6353", lineHeight: 1, whiteSpace: "nowrap", transition: "color 0.3s" }}>Features</Link>
          <Link href="/how-it-works" className="cine-nav-link font-body" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", padding: "7px 16px", borderRadius: 9, fontSize: 14, fontWeight: 400, background: "transparent", color: "#6E6353", lineHeight: 1, whiteSpace: "nowrap", transition: "color 0.3s" }}>How it works</Link>
          <div style={{ position: "relative", display: "flex" }}>
            <button onClick={() => setNavMoreOpen((v) => !v)} className="cine-nav-link font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 9, fontSize: 14, fontWeight: 400, background: navMoreOpen ? "rgba(107,87,201,0.10)" : "transparent", color: navMoreOpen ? "#51409A" : "#6E6353", border: "none", lineHeight: 1, whiteSpace: "nowrap", cursor: "pointer", transition: "color 0.3s, background 0.3s" }}>
              <span>More</span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${navMoreOpen ? "180deg" : "0deg"})`, transition: "transform 0.35s cubic-bezier(0.16,1,0.3,1)" }}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {navMoreOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 14px)", right: 0, width: 248, background: "linear-gradient(160deg, rgba(254,252,248,0.98), rgba(250,247,241,0.97))", border: "1px solid rgba(107,87,201,0.14)", borderRadius: 18, boxShadow: "0 24px 70px rgba(43,37,25,0.18)", padding: 8, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", animation: "morePanelIn 0.4s cubic-bezier(0.16,1,0.3,1) both", display: "flex", flexDirection: "column", gap: 2 }}>
                {[
                  { title: "Donate", sub: "Support the seva", on: () => { setModal("donate"); setNavMoreOpen(false); setCopied(null); } },
                  { title: "Feature request", sub: "Shape what comes next", on: () => { setModal("feature"); setNavMoreOpen(false); setFeatSent(false); } },
                  { title: "Feedback", sub: "Two minutes, from the heart", on: () => { setModal("feedback"); setNavMoreOpen(false); setFbSent(false); } },
                ].map((it) => (
                  <button key={it.title} onClick={it.on} className="cine-nav-menu-item font-body" style={{ textAlign: "left", padding: "11px 13px", borderRadius: 12, border: "none", background: "transparent", cursor: "pointer", transition: "background 0.25s" }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#2B2519" }}>{it.title}</span>
                    <span style={{ display: "block", fontSize: 12, color: "#9A8F7D", marginTop: 2 }}>{it.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>
      </header>

      {/* Persistent sound toggle (after entrance) */}
      {!lockVisible && (
        <button onClick={toggleSound} aria-label="Toggle ambient sound" title="Ambient sound" className="cine-sound-float" style={{ position: "fixed", bottom: 20, left: 20, zIndex: 500, width: 42, height: 42, borderRadius: "50%", border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", color: soundColor, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 18px rgba(43,37,25,0.08)", transition: "all 0.3s ease" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" opacity={soundWaveOp} /></svg>
        </button>
      )}

      {/* Floating feedback — cinematic entrance/exit */}
      {!lockVisible && (
        <button onClick={() => { setModal("feedback"); setNavMoreOpen(false); setFbSent(false); }} aria-label="Send feedback" className="cine-fab"
          style={{ position: "fixed", bottom: 20, right: 20, zIndex: 500, display: "inline-flex", alignItems: "center", gap: 9, padding: "13px 22px", borderRadius: 100, border: "1px solid rgba(255,244,214,0.35)", background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFF8E8", fontSize: 13, fontWeight: 500, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "0 10px 34px rgba(107,87,201,0.35)", animation: "fabIn 0.9s cubic-bezier(0.16,1,0.3,1) 0.6s backwards", opacity: modal || footerNear ? 0 : 1, transform: `translateY(${modal || footerNear ? "18px" : "0px"}) scale(${modal || footerNear ? "0.92" : "1"})`, pointerEvents: modal || footerNear ? "none" : "auto", transition: "opacity 0.4s ease, transform 0.5s cubic-bezier(0.16,1,0.3,1), box-shadow 0.35s ease" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
          <span>Feedback</span>
        </button>
      )}

      {/* ═══════════ MAIN PAGE (camera-pull wrapper) ═══════════ */}
      <div style={{ opacity: main.op, transform: `scale(${main.scale})`, transformOrigin: "50% 20%", transition: "opacity 1.0s ease 0.25s, transform 1.3s cubic-bezier(0.16,1,0.3,1) 0.15s", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <main style={{ flex: 1 }}>

          {/* ── HERO ── */}
          <section style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px clamp(16px,4vw,80px) 60px", position: "relative", overflow: "hidden" }}>
            <div aria-hidden style={{ position: "absolute", top: "44%", left: "50%", width: "min(90vw,760px)", height: "min(90vw,760px)", borderRadius: "50%", background: "radial-gradient(circle, rgba(139,110,224,0.20) 0%, rgba(201,162,75,0.10) 40%, transparent 70%)", filter: "blur(60px)", transform: "translate(-50%,-50%)", animation: "auraBreathe 9s ease-in-out infinite", pointerEvents: "none" }} />
            {showMotes && (
              <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
                {motes.map((s, i) => <span key={i} aria-hidden style={s} />)}
              </div>
            )}

            <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: 880 }}>
              <div style={{ overflow: "hidden", padding: "2px 0" }}>
                <p className="font-body" style={{ fontSize: "clamp(11px,1.2vw,13px)", fontWeight: 600, letterSpacing: "0.42em", textTransform: "uppercase", color: "#9A8F7D", marginLeft: "0.42em", transform: `translateY(${hr.l1})`, transition: "transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.15s" }}>Ask</p>
              </div>
              <div style={{ overflow: "hidden", padding: "8px 0 6px", maxWidth: "100%" }}>
                <h1 className="font-display" style={{ fontSize: "clamp(44px, 9.5vw, 128px)", fontWeight: 600, textAlign: "center", letterSpacing: "-0.03em", lineHeight: 1.02, background: "linear-gradient(120deg, #201B12 20%, #6B57C9 55%, #C9A24B 90%)", backgroundSize: "220% 220%", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", animation: "gradientText 10s ease-in-out infinite alternate", transform: `translateY(${hr.l2})`, transition: "transform 1.1s cubic-bezier(0.16,1,0.3,1) 0.3s", overflowWrap: "break-word" }}>Śrīla Prabhupāda</h1>
              </div>
              <div style={{ overflow: "hidden", padding: "2px 0" }}>
                <p className="font-display" style={{ fontSize: "clamp(17px, 2.4vw, 24px)", fontStyle: "italic", fontWeight: 500, textAlign: "center", color: "#6E6353", transform: `translateY(${hr.l3})`, transition: "transform 1.0s cubic-bezier(0.16,1,0.3,1) 0.5s" }}>Nothing added. Nothing invented.</p>
              </div>

              <form onSubmit={(e) => { e.preventDefault(); runSearch(query); }} style={{ width: "100%", maxWidth: 720, position: "relative", marginTop: 40, opacity: hr.formOp, transform: `translateY(${hr.formY})`, transition: "opacity 0.9s ease 0.75s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.75s" }}>
                <div style={{ position: "relative", borderRadius: 20, padding: 1.5, background: `linear-gradient(135deg, ${wrapFrom}, ${wrapTo})`, boxShadow: wrapGlow, transition: "background 0.3s cubic-bezier(0.2,0,0,1), box-shadow 0.5s cubic-bezier(0.2,0,0,1)" }}>
                  <textarea ref={textareaRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSearch(query); } }} onFocus={() => setFocused(true)} onBlur={() => { if (!query) setFocused(false); }} aria-label="Search Prabhupāda's books" rows={1} className="font-body" style={{ width: "100%", display: "block", padding: "22px clamp(100px,16vw,120px) 22px clamp(18px,3vw,28px)", fontSize: "clamp(15px,2.8vw,18px)", fontWeight: 400, border: "none", borderRadius: 18, background: "#FEFCF8", color: "#2B2519", outline: "none", resize: "none", overflow: "hidden", lineHeight: 1.5 }} />
                  {!query && !focused && (
                    <span aria-hidden className="font-body" style={{ position: "absolute", left: 28, top: 24, right: 104, fontSize: "clamp(15px,2.8vw,18px)", color: "#6E6353", pointerEvents: "none", display: "flex", alignItems: "center", overflow: "hidden", whiteSpace: "nowrap" }}>{twText}<span style={{ display: "inline-block", width: 2, height: "1.2em", background: "#6B57C9", marginLeft: 1, animation: "typewriterBlink 0.8s step-end infinite", opacity: 0.7 }} /></span>
                  )}
                  {!query && focused && (
                    <span aria-hidden className="font-body" style={{ position: "absolute", left: 28, top: 24, right: 104, fontSize: "clamp(15px,2.8vw,18px)", color: "#9A8F7D", pointerEvents: "none", lineHeight: 1.5, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>Ask anything about the scriptures...</span>
                  )}
                  <div style={{ position: "absolute", right: 62, top: 16 }}>
                    <button type="button" aria-label="Voice input" className="cine-voice-btn" style={{ width: 40, height: 40, borderRadius: 12, border: "none", background: "transparent", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s ease" }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="23" /><line x1="8" x2="16" y1="23" y2="23" /></svg>
                    </button>
                  </div>
                  <button type="submit" aria-label="Search" disabled={!can} className="cine-submit-btn" style={{ position: "absolute", right: 10, top: 12, width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", cursor: can ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", opacity: can ? 1 : 0.4, transition: "all 0.3s cubic-bezier(0.2,0,0,1)", boxShadow: can ? "0 4px 14px rgba(107,87,201,0.30)" : "none" }}>
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                </div>
              </form>

              <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 8, opacity: hr.formOp, transition: "opacity 0.9s ease 1.0s" }}>
                {EXAMPLE_QUESTIONS.slice(0, 3).map((q) => (
                  <button key={q} onClick={pick(q)} className="cine-pill font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.8)", fontSize: 13, fontWeight: 400, color: "#2B2519", cursor: "pointer", transition: "all 0.35s cubic-bezier(0.2,0,0,1)", whiteSpace: "nowrap" }}>{q}</button>
                ))}
                <button onClick={() => setMoreOpen(true)} className="cine-more-pill font-body" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 100, border: "1px dashed rgba(107,87,201,0.35)", background: "rgba(107,87,201,0.05)", fontSize: 13, fontWeight: 500, color: "#51409A", cursor: "pointer", transition: "all 0.35s cubic-bezier(0.2,0,0,1)", whiteSpace: "nowrap" }}>More questions <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg></button>
              </div>
            </div>

            <div aria-hidden style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, opacity: hr.formOp, transition: "opacity 1s ease 1.4s" }}>
              <span className="font-body" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.3em", textTransform: "uppercase", color: "#9A8F7D", marginLeft: "0.3em" }}>Scroll</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "scrollCue 2.2s ease-in-out infinite", color: "#9A8F7D" }}><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
          </section>

          {/* ── THE LIBRARY ── */}
          <section data-creveal="lib" style={{ padding: "clamp(80px,12vh,140px) clamp(24px,6vw,100px)", maxWidth: 1280, margin: "0 auto", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: "clamp(40px,6vh,64px)", opacity: rev("lib").op, transform: `translateY(${rev("lib").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
              <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>The library</p>
              <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
            </div>
            <h2 className="font-display" style={{ fontSize: "clamp(30px,4.4vw,58px)", fontWeight: 600, lineHeight: 1.12, letterSpacing: "-0.02em", color: "#201B12", maxWidth: 760, marginBottom: "clamp(48px,8vh,80px)", textWrap: "pretty", opacity: rev("lib").op, transform: `translateY(${rev("lib").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1) 0.1s, transform 0.9s cubic-bezier(0.16,1,0.3,1) 0.1s" }}>Everything he wrote and spoke, <span style={{ fontStyle: "italic", color: "#6B57C9" }}>searched together.</span></h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "clamp(32px,4vw,56px)" }}>
              {[
                { n: stats.books.toLocaleString("en-US"), label: "Books", desc: "Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, and 30+ more titles.", delay: "0.2s" },
                { n: stats.lectures.toLocaleString("en-US") + "+", label: "Lectures", desc: "Transcribed lectures, conversations, and morning walks spanning decades of teaching.", delay: "0.35s" },
                { n: stats.letters.toLocaleString("en-US") + "+", label: "Letters", desc: "Personal correspondence and instructions to disciples, friends, and world leaders.", delay: "0.5s" },
              ].map((c) => (
                <div key={c.label} style={{ borderTop: "1px solid #D8CCB8", paddingTop: 26, opacity: rev("lib").op, transform: `translateY(${rev("lib").ty})`, transition: `opacity 0.9s cubic-bezier(0.16,1,0.3,1) ${c.delay}, transform 0.9s cubic-bezier(0.16,1,0.3,1) ${c.delay}` }}>
                  <p className="font-display" style={{ fontSize: "clamp(64px,8vw,120px)", fontWeight: 500, letterSpacing: "-0.03em", color: "#201B12", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{c.n}</p>
                  <h3 className="font-body" style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.22em", textTransform: "uppercase", color: "#6B57C9", margin: "14px 0 10px" }}>{c.label}</h3>
                  <p className="font-body" style={{ fontSize: 15, lineHeight: 1.7, color: "#6E6353", maxWidth: "34ch" }}>{c.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── PINNED HORIZONTAL GALLERY ── */}
          <section data-pin="hgallery" style={{ height: "300vh", position: "relative" }}>
            <div style={{ position: "sticky", top: 0, height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ padding: "0 clamp(24px,6vw,100px)", marginBottom: 34, display: "flex", alignItems: "baseline", gap: 20 }}>
                <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>Moments</p>
                <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
                <p className="font-display" style={{ fontSize: "clamp(18px,2vw,24px)", fontStyle: "italic", color: "#9A8F7D", whiteSpace: "nowrap" }}>a life in frames</p>
              </div>
              <div data-htrack style={{ display: "flex", gap: "clamp(20px,2.5vw,36px)", padding: "0 clamp(24px,6vw,100px)", willChange: "transform", alignItems: "stretch" }}>
                {GALLERY.map((g) => (
                  <div key={g.id} style={{ flex: "0 0 auto", width: "clamp(280px, 36vw, 520px)", display: "flex", flexDirection: "column", gap: 14, marginTop: g.offset ? "clamp(20px,4vh,44px)" : 0 }}>
                    <div style={{ width: "100%", height: "min(58vh, 520px)", borderRadius: 18, backgroundImage: `url('${g.img}')`, backgroundSize: "cover", backgroundPosition: "center", boxShadow: "0 20px 60px rgba(43,37,25,0.14)" }} />
                    <p className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: "#9A8F7D" }}>{g.caption}</p>
                  </div>
                ))}
                <div style={{ flex: "0 0 auto", width: "clamp(300px, 40vw, 560px)", display: "flex", alignItems: "center", padding: "0 clamp(12px,2vw,32px)" }}>
                  <div>
                    <div aria-hidden style={{ width: 56, height: 1, background: "#C9A24B", marginBottom: 22 }} />
                    <p className="font-display" style={{ fontSize: "clamp(24px,3vw,40px)", fontStyle: "italic", fontWeight: 500, color: "#201B12", lineHeight: 1.35, textWrap: "pretty" }}>Every photograph is a moment he was teaching.</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ── PINNED MANIFESTO — per-word scrub ── */}
          <section data-pin="manifesto" style={{ height: "240vh", position: "relative" }}>
            <div style={{ position: "sticky", top: 0, height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 clamp(24px,6vw,100px)", textAlign: "center", overflow: "hidden" }}>
              <p className="font-display" style={{ fontSize: "clamp(34px, 5.6vw, 80px)", fontWeight: 600, lineHeight: 1.18, letterSpacing: "-0.02em", color: "#201B12", maxWidth: 1000, textWrap: "balance" }}>
                {MANIFESTO_WORDS.map((line, li) => (
                  <span key={li}>
                    {line.map((w, wi) => (
                      <span key={wi} data-word style={{ opacity: 0.1, filter: "blur(5px)", display: "inline-block", transition: "opacity 0.35s ease, filter 0.35s ease" }}>{w}{" "}</span>
                    ))}
                    {li === 0 && <br />}
                  </span>
                ))}
              </p>
              <p data-manifesto-tail className="font-display" style={{ fontSize: "clamp(20px, 2.6vw, 34px)", fontStyle: "italic", marginTop: 34, background: "linear-gradient(120deg, #C9A24B, #6B57C9)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", opacity: 0, transform: "translateY(14px)", transition: "opacity 0.5s ease, transform 0.5s ease" }}>Nothing added. Nothing invented.</p>
              <p className="font-body" style={{ fontSize: "clamp(14px,1.5vw,16px)", lineHeight: 1.7, color: "#6E6353", maxWidth: 560, marginTop: 26 }}>The search retrieves and connects Śrīla Prabhupāda's original words — translations and purports. It never generates philosophy. Every citation links to Vedabase.io.</p>
            </div>
          </section>

          {/* ── WHY DIFFERENT rows ── */}
          <section data-creveal="why" style={{ padding: "clamp(60px,10vh,120px) clamp(24px,6vw,100px) clamp(80px,12vh,140px)", maxWidth: 1280, margin: "0 auto", width: "100%" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: "clamp(40px,6vh,64px)", opacity: rev("why").op, transform: `translateY(${rev("why").ty})`, transition: "opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)" }}>
              <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", whiteSpace: "nowrap" }}>Why this is different</p>
              <div aria-hidden style={{ flex: 1, height: 1, background: "#E8E0D2" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {[
                { n: "01", title: "His words, not AI's", desc: "Answers are woven verbatim from Śrīla Prabhupāda's original texts — translations and purports. The search retrieves and connects. It never generates philosophy.", delay: "0.12s", last: false },
                { n: "02", title: "Exact citations, always", desc: "Every reference links directly to Vedabase.io. Click any citation to read the full verse, synonyms, and complete purport in context.", delay: "0.26s", last: false },
                { n: "03", title: "The complete library, at once", desc: "36 books, 3,700 lectures, and 6,500 letters — Bhagavad Gītā to personal correspondence — searched together, instantly.", delay: "0.4s", last: true },
              ].map((r) => (
                <div key={r.n} style={{ display: "grid", gridTemplateColumns: "minmax(56px, 96px) 1fr", gap: "clamp(16px,3vw,40px)", alignItems: "start", padding: "clamp(28px,4vh,44px) 0", borderTop: "1px solid #E8E0D2", borderBottom: r.last ? "1px solid #E8E0D2" : undefined, opacity: rev("why").op, transform: `translateY(${rev("why").ty})`, transition: `opacity 0.9s cubic-bezier(0.16,1,0.3,1) ${r.delay}, transform 0.9s cubic-bezier(0.16,1,0.3,1) ${r.delay}` }}>
                  <span className="font-display" style={{ fontSize: "clamp(22px,2.6vw,32px)", fontWeight: 500, color: "#C9A24B", lineHeight: 1.3 }}>{r.n}</span>
                  <div>
                    <h3 className="font-display" style={{ fontSize: "clamp(26px,3.4vw,44px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", lineHeight: 1.15, marginBottom: 12 }}>{r.title}</h3>
                    <p className="font-body" style={{ fontSize: "clamp(15px,1.6vw,17px)", lineHeight: 1.7, color: "#6E6353", maxWidth: "62ch" }}>{r.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── JOURNEY TEASER ── */}
          <Link href="/journey" data-creveal="journey" className="cine-journey" style={{ textDecoration: "none", display: "block", position: "relative", minHeight: "clamp(420px, 68vh, 640px)", overflow: "hidden", cursor: "pointer" }}>
            <div data-parallax="0.14" style={{ position: "absolute", inset: "-16% 0", backgroundImage: `url('${IMG.walk}')`, backgroundSize: "cover", backgroundPosition: "center 40%", willChange: "transform" }} />
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(22,18,12,0.34) 26%, rgba(22,18,12,0.42) 60%, rgba(22,18,12,0.78) 100%)" }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "60px 24px", opacity: rev("journey").op, transform: `translateY(${rev("journey").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
              <p className="font-display" style={{ fontSize: "clamp(80px, 14vw, 200px)", fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1, color: "rgba(255,248,232,0.95)", textShadow: "0 6px 60px rgba(22,18,12,0.5)" }}>1965</p>
              <p className="font-display" style={{ fontSize: "clamp(20px, 2.8vw, 34px)", fontStyle: "italic", color: "rgba(255,248,232,0.92)", marginTop: 12, textWrap: "pretty", maxWidth: 640 }}>He crossed an ocean at sixty-nine.</p>
              <span className="cine-journey-btn font-body" style={{ display: "inline-flex", alignItems: "center", gap: 10, marginTop: 30, padding: "13px 32px", border: "1px solid rgba(255,244,214,0.45)", borderRadius: 100, color: "#FFF8E8", fontSize: 13, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", background: "rgba(22,18,12,0.25)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)" }}>The journey <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            </div>
          </Link>

          {/* ── TESTIMONIAL ── */}
          <section data-creveal="test" style={{ padding: "clamp(60px,10vh,120px) clamp(24px,6vw,100px)", maxWidth: 900, margin: "0 auto", width: "100%", textAlign: "center", opacity: rev("test").op, transform: `translateY(${rev("test").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
            <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.32em", color: "#6B57C9", marginBottom: 36 }}>From the devotees</p>
            <div style={{ minHeight: 190, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <p className="font-display" style={{ fontSize: "clamp(20px,2.8vw,32px)", fontStyle: "italic", fontWeight: 500, lineHeight: 1.45, color: "#2B2519", textWrap: "pretty", opacity: tVisible ? 1 : 0, transform: `translateY(${tVisible ? "0px" : "10px"})`, transition: "opacity 0.6s ease, transform 0.6s cubic-bezier(0.16,1,0.3,1)" }}>“{t.quote}”</p>
              <div style={{ marginTop: 26, opacity: tVisible ? 1 : 0, transition: "opacity 0.6s ease 0.1s" }}>
                <p className="font-body" style={{ fontSize: 14, fontWeight: 600, color: "#201B12" }}>{t.name}</p>
                <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 2 }}>{t.role}</p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 28 }}>
              {TESTIMONIALS.map((_, i) => (
                <button key={i} onClick={() => { if (tRotRef.current) clearInterval(tRotRef.current); setTIdx(i); setTVisible(true); }} aria-label="Show testimonial" style={{ width: i === tIdx ? 26 : 6, height: 6, borderRadius: 100, border: "none", background: i === tIdx ? "#6B57C9" : "#D8CCB8", cursor: "pointer", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)", padding: 0 }} />
              ))}
            </div>
          </section>

          {/* ── CTA ── */}
          <section style={{ position: "relative", minHeight: "clamp(440px, 74vh, 700px)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div data-parallax="0.12" style={{ position: "absolute", inset: "-16% 0", backgroundImage: `url('${IMG.disciples}')`, backgroundSize: "cover", backgroundPosition: "center 28%", willChange: "transform" }} />
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(250,247,241,1) 0%, rgba(250,247,241,0.55) 24%, rgba(250,247,241,0.30) 55%, rgba(250,247,241,0.88) 100%)" }} />
            <div style={{ position: "absolute", inset: 0, background: "radial-gradient(70% 60% at 50% 55%, rgba(250,247,241,0.72), transparent 78%)" }} />
            <div data-creveal="cta" style={{ position: "relative", zIndex: 1, textAlign: "center", padding: "80px 24px", opacity: rev("cta").op, transform: `translateY(${rev("cta").ty})`, transition: "opacity 1s cubic-bezier(0.16,1,0.3,1), transform 1s cubic-bezier(0.16,1,0.3,1)" }}>
              <h2 className="font-display" style={{ fontSize: "clamp(34px,5vw,68px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#201B12", marginBottom: 18, textWrap: "balance" }}>Ask your first question</h2>
              <p className="font-body" style={{ fontSize: "clamp(15px,1.7vw,18px)", lineHeight: 1.7, color: "#6E6353", maxWidth: 480, margin: "0 auto 34px" }}>36 books. 3,700 lectures. 6,500 letters. Every answer grounded in Śrīla Prabhupāda's actual words.</p>
              <button onClick={focusSearch} className="cine-cta-btn font-body" style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", borderRadius: 100, padding: "16px 40px", fontSize: 15, fontWeight: 500, letterSpacing: "0.04em", cursor: "pointer", boxShadow: "0 10px 34px rgba(107,87,201,0.30)", transition: "all 0.45s cubic-bezier(0.16,1,0.3,1)" }}><span>Search the books</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
            </div>
          </section>

          <footer style={{ borderTop: "1px solid #E8E0D2", padding: "20px clamp(20px,5vw,80px)", maxWidth: 1280, margin: "0 auto", width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <span className="font-body" style={{ fontSize: 13, color: "#6E6353" }}>© 2026 All rights reserved</span>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <a href="https://github.com/asksrilaprabhupada/nextjs-boilerplate" target="_blank" rel="noopener noreferrer" className="cine-nav-link font-body" style={{ fontSize: 13, color: "#6E6353", textDecoration: "none", transition: "color 0.3s ease" }}>GitHub</a>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
