/**
 * 19-ask-home.tsx — The home page: the doorway, then Ask (cinematic redesign)
 *
 * Designs: docs/redesign/designs/Ask.dc.html (desktop and iPad) and
 * PhoneAsk.dc.html (phone). The page is only what the design shows: the dark
 * hero (a faint Vṛndāvana deities photo on a slow 24-second zoom, drifting
 * gold and violet glows, a grain tile, and floating light bubbles that are
 * already mid-flight), "Ask / Śrīla Prabhupāda / Nothing added. Nothing
 * invented.", the search box with its travelling gold-and-violet rim and
 * breathing halo, the self-typing questions, the "Search in" switch (only when
 * Advanced is switched on), three sample questions, the library numbers, the
 * three trust cards, and the footer.
 *
 * The Moments filmstrip, manifesto, 1965 teaser, sample voices and closing door
 * of the previous home (01-cinematic-home.tsx) are kept in that file, unmounted.
 *
 * Submitting goes to /search?q=… (or /advanced?q=… when Advanced is chosen).
 * Everything behind the doorway waits, paused, until the doorway opens.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import Doorway from "./16-doorway";
import SelfTyping from "./17-self-typing";
import SearchInSwitch, { type SearchScope } from "./18-search-in-switch";
import { ADVANCED_ENABLED } from "@/app/lib/28-advanced-flag";

const SAMPLE_QUESTIONS = [
  "What is the purpose of human life?",
  "How to control the mind?",
  "What happens after death?",
];

/* The library numbers the site already shows (36 books, 3,700+ lectures,
   6,500+ letters) — the same figures as before the redesign. */
const LIBRARY = [
  { n: "36", label: "Books", desc: "Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, and 32 more titles." },
  { n: "3,700+", label: "Lectures", desc: "Transcribed lectures, conversations, and morning walks spanning decades of teaching." },
  { n: "6,500+", label: "Letters", desc: "Personal correspondence and instructions to disciples, friends, and world leaders." },
];

const TRUST = [
  { num: "I", title: "His words, not AI's", body: "Answers are woven verbatim from his translations and purports. The search retrieves and connects — it never generates philosophy." },
  { num: "II", title: "Exact citations, always", body: "Every reference links to Vedabase.io — the full verse, synonyms, and complete purport are one click away." },
  { num: "III", title: "Verified before it renders", body: "Every rendered quote is checked against its source row in the library — nothing paraphrased slips through." },
];

type Bubble = [left: number, bottom: number, size: number, path: string, dur: number, delay: number, opacity: number, kind: "g" | "l" | "G" | "L"];

/* Copied from the design's .asp-bubs blocks: 16 dots + 5 discs on desktop,
   9 + 3 on phone; every third dot gold, the rest lavender. */
const BUBBLES_DESKTOP: readonly Bubble[] = [
  [33.8, -2.5, 9, "dA", 16.9, -6.2, 0.48, "g"], [9.3, 15.4, 5, "dB", 11.8, -1.1, 0.62, "l"],
  [43.1, 31.3, 6, "dC", 17.9, -17.0, 0.54, "l"], [57.1, 9.8, 11, "dD", 20.4, -5.9, 0.47, "g"],
  [17.3, -4.1, 7, "dA", 13.0, -7.6, 0.78, "l"], [62.8, 8.6, 8, "dB", 11.7, -2.4, 0.48, "l"],
  [66.6, 11.4, 7, "dC", 16.0, -4.8, 0.68, "g"], [77.1, 24.9, 6, "dD", 16.8, -14.7, 0.68, "l"],
  [71.1, 4.4, 11, "dA", 15.6, -11.8, 0.5, "l"], [18.0, 14.4, 5, "dB", 19.4, -11.1, 0.72, "g"],
  [84.5, 5.7, 9, "dC", 17.4, -7.9, 0.69, "l"], [81.3, 37.2, 8, "dD", 11.7, -8.2, 0.72, "l"],
  [63.5, 39.7, 10, "dA", 15.2, -10.2, 0.56, "g"], [6.1, 13.1, 6, "dB", 11.6, -8.9, 0.5, "l"],
  [15.9, 2.4, 7, "dC", 11.9, -5.3, 0.8, "l"], [54.5, 34.2, 10, "dD", 14.1, -5.8, 0.8, "g"],
  [37.6, 15.9, 35, "dD", 25.8, -6.0, 0.39, "G"], [26.5, 2.0, 29, "dC", 24.0, -10.1, 0.42, "L"],
  [38.5, 4.8, 35, "dB", 29.2, -18.0, 0.52, "G"], [65.5, -13.1, 34, "dA", 32.7, -26.1, 0.54, "L"],
  [40.5, -1.0, 20, "dD", 24.6, -1.7, 0.51, "G"],
];
const BUBBLES_PHONE: readonly Bubble[] = [
  [45.6, 18.0, 11, "pA", 16.6, -9.7, 0.64, "g"], [21.0, 15.6, 9, "pB", 12.0, -3.7, 0.77, "l"],
  [12.3, 30.5, 9, "pC", 21.8, -21.0, 0.47, "l"], [64.2, 20.8, 6, "pD", 16.8, -1.0, 0.46, "g"],
  [21.5, 2.1, 5, "pA", 15.8, -13.3, 0.64, "l"], [51.8, 22.0, 8, "pB", 16.0, -4.5, 0.71, "l"],
  [95.8, 39.8, 10, "pC", 14.5, -3.3, 0.73, "g"], [30.6, -6.5, 10, "pD", 20.3, -7.9, 0.61, "l"],
  [92.1, 32.4, 5, "pA", 21.0, -9.9, 0.53, "l"],
  [92.3, -1.1, 19, "pD", 31.8, -8.6, 0.51, "G"], [13.7, -3.4, 35, "pC", 25.2, -6.2, 0.54, "L"],
  [14.9, -12.9, 32, "pB", 29.6, -13.2, 0.39, "G"],
];
const BUBBLE_FILL: Record<Bubble[7], string> = {
  g: "radial-gradient(circle, rgba(255,246,222,0.95) 0%, rgba(217,183,106,0.75) 32%, rgba(217,183,106,0) 70%)",
  l: "radial-gradient(circle, rgba(240,234,255,0.95) 0%, rgba(165,140,240,0.7) 32%, rgba(139,110,224,0) 70%)",
  G: "radial-gradient(circle, rgba(217,183,106,0.10) 0%, rgba(217,183,106,0.16) 56%, rgba(255,240,205,0.5) 65%, rgba(217,183,106,0) 72%)",
  L: "radial-gradient(circle, rgba(165,140,240,0.10) 0%, rgba(165,140,240,0.15) 56%, rgba(235,228,255,0.45) 65%, rgba(139,110,224,0) 72%)",
};

function Bubbles({ list, className }: { list: readonly Bubble[]; className: string }) {
  return (
    <div className={`asp-bubs ${className}`} aria-hidden="true">
      {list.map(([left, bottom, size, path, dur, delay, opacity, kind], i) => (
        <span
          key={i}
          className="asp-bub"
          style={{
            left: `${left}%`,
            bottom: `${bottom}%`,
            width: size,
            height: size,
            animation: `asp-bub-${path} ${dur}s cubic-bezier(.37,0,.63,1) ${delay}s infinite`,
          }}
        >
          <span style={{ opacity, background: BUBBLE_FILL[kind] }} />
        </span>
      ))}
    </div>
  );
}

/* ── Voice: offered only where the browser can actually listen ── */

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export default function AskHome() {
  const router = useRouter();
  const [doorOpen, setDoorOpen] = useState(false);
  const [doorShowing, setDoorShowing] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("prabhupada");
  const [canListen, setCanListen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const heardRef = useRef("");

  const onDoorOpen = useCallback(() => setDoorOpen(true), []);
  const onDoorShow = useCallback(() => setDoorShowing(true), []);

  useEffect(() => {
    setCanListen(recognitionCtor() !== null);
    return () => recognitionRef.current?.stop();
  }, []);

  const runSearch = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      const base = ADVANCED_ENABLED && scope === "advanced" ? "/advanced" : "/search";
      router.push(`${base}?q=${encodeURIComponent(trimmed)}`);
    },
    [router, scope],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    runSearch(query);
  };

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    heardRef.current = "";
    recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
      heardRef.current = text.trim();
      setQuery(heardRef.current);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      if (heardRef.current) runSearch(heardRef.current);
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  };

  return (
    <div className="asp-page asp-home">
      <Doorway onShow={onDoorShow} onOpen={onDoorOpen} />

      <div className="asp-door-behind" inert={doorShowing && !doorOpen ? true : undefined}>
        <section className="asp-dark asp-ask-hero" aria-label="Ask Śrīla Prabhupāda">
          <div aria-hidden="true" className="asp-ask-base" />
          <div aria-hidden="true" className="asp-ask-photo">
            <div className="asp-ask-photo-img asp-kb" />
          </div>
          <div aria-hidden="true" className="asp-layer asp-ask-dim" />
          <div aria-hidden="true" className="asp-ask-glow-gold asp-drift" />
          <div aria-hidden="true" className="asp-ask-glow-violet asp-drift" />
          <div aria-hidden="true" className="asp-ask-glow-phone" />
          <div aria-hidden="true" className="asp-layer asp-ask-shade" />
          <div aria-hidden="true" className="asp-grain" />
          <Bubbles list={BUBBLES_DESKTOP} className="asp-bubs-desk" />
          <Bubbles list={BUBBLES_PHONE} className="asp-bubs-phone" />

          <SiteHeader />

          <div className="asp-hero">
            <p className="asp-eyebrow asp-rise">Ask</p>
            <h1 className="asp-word asp-rise" style={{ animationDelay: "100ms" }}>
              Śrīla <br className="asp-word-br" />Prabhupāda
            </h1>
            <p className="asp-tagline asp-rise" style={{ animationDelay: "200ms" }}>Nothing added. Nothing invented.</p>

            <form role="search" aria-label="Ask a question" className="asp-ask-form asp-rise" style={{ animationDelay: "320ms" }} onSubmit={submit}>
              <div className="asp-box">
                <span aria-hidden="true" className="asp-halo" />
                <div className="asp-frame">
                  <span aria-hidden="true" className="asp-rim" />
                  <div className="asp-box-inner">
                    <svg aria-hidden="true" className="asp-box-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6e6353" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="7" />
                      <path d="M20 20l-3.5-3.5" />
                    </svg>
                    <label htmlFor="asp-q-ask" className="asp-sr">Your question</label>
                    <span className="asp-qwrap">
                      <input
                        id="asp-q-ask"
                        type="search"
                        name="q"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        autoComplete="off"
                        enterKeyHint="search"
                        maxLength={500}
                      />
                      <SelfTyping active={doorOpen} hidden={query.length > 0} />
                    </span>
                    {canListen && (
                      <button
                        className="asp-mic"
                        type="button"
                        aria-label={listening ? "Stop listening" : "Ask by voice"}
                        aria-pressed={listening}
                        onClick={toggleVoice}
                      >
                        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="3" width="6" height="11" rx="3" />
                          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                        </svg>
                      </button>
                    )}
                    <button className="asp-cta" type="submit" aria-label="Ask">
                      <span className="asp-cta-label" aria-hidden="true">Ask</span>
                      <svg aria-hidden="true" className="asp-cta-arrow-desk" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                      <svg aria-hidden="true" className="asp-cta-arrow-phone" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                      <span aria-hidden="true" className="asp-cta-glint asp-glint" />
                    </button>
                  </div>
                </div>
              </div>
            </form>

            {ADVANCED_ENABLED && <SearchInSwitch value={scope} onChange={setScope} />}

            <div className="asp-chips asp-rise" style={{ animationDelay: "520ms" }}>
              {SAMPLE_QUESTIONS.map((q) => (
                <button key={q} type="button" className="asp-chip" onClick={() => runSearch(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>

          <div aria-hidden="true" className="asp-scrollcue">
            <span className="asp-scrollcue-label">Scroll</span>
            <span className="asp-scrollcue-track">
              <span className="asp-scrollcue-line" />
            </span>
          </div>
        </section>

        <div aria-hidden="true" className="asp-fade" />

        <section aria-labelledby="asp-lib-h" className="asp-lib asp-sec">
          <div className="asp-wrap">
            <p className="asp-kicker">The library</p>
            <h2 id="asp-lib-h" className="asp-h2">
              Everything he wrote and spoke, <em>searched together.</em>
            </h2>
            <div className="asp-g3 asp-stats">
              {LIBRARY.map((item) => (
                <div key={item.label} className="asp-stat">
                  <p className="asp-stat-n">{item.n}</p>
                  <p className="asp-stat-label">{item.label}</p>
                  <p className="asp-stat-desc">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="asp-trust-h" className="asp-trust asp-sec">
          <div className="asp-wrap">
            <div className="asp-trust-rule" />
            <h2 id="asp-trust-h" className="asp-h2">
              He wrote every word. <em>We only help you find them.</em>
            </h2>
            <div className="asp-g3 asp-cards">
              {TRUST.map((card) => (
                <article key={card.title} className="asp-card">
                  <p aria-hidden="true" className="asp-card-num">{card.num}</p>
                  <h3>{card.title}</h3>
                  <p className="asp-card-body">{card.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <SiteFooter showName />
      </div>
    </div>
  );
}
