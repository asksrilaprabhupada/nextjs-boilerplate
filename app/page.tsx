// app/page.tsx
"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState, FormEvent } from "react";

/* ---------- Types ---------- */
type Row = {
  work: string;
  chapter: number;
  verse: number;
  verse_label: string | null;
  translation: string | null;
  purport: string | null;
  rank?: number;
};
type SourceLink = { label: string; url: string };
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; rows?: Row[]; sources?: SourceLink[] };

/* ---------- Helpers ---------- */
function vedabaseUrl(chapter: number, verse_label: string | null, verse: number) {
  const label = (verse_label || String(verse)).replace(/[^\d-]/g, "");
  return `https://vedabase.io/en/library/bg/${chapter}/${label}/`;
}

const LANDING_IMAGES = [
  "/landing/prabhupada-1.jpg",
  "/landing/prabhupada-2.jpg",
  "/landing/prabhupada-3.jpg",
  "/landing/prabhupada-4.jpg",
  "/landing/prabhupada-5.jpg",
];

/* ---------- Page ---------- */
export default function Home() {
  const [showSplash, setShowSplash] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true); // collapsible history rail

  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Random landing image (stable per page load)
  const landing = useMemo(
    () => LANDING_IMAGES[Math.floor(Math.random() * LANDING_IMAGES.length)],
    []
  );

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);

    try {
      // Prefer narrative endpoint; fall back to bare search if not found
      let r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      });

      if (r.status === 404) {
        r = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, k: 5 }),
        });
      }

      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Request failed");

      const answer: string | undefined = data.answer;
      const rows: Row[] = data.rows || [];
      const sources: SourceLink[] =
        data.sources ||
        (rows.length
          ? Array.from(
              new Map(
                rows.map((row: Row) => {
                  const label = row.verse_label || String(row.verse);
                  return [
                    `${row.chapter}:${label}`,
                    {
                      label: `BG ${row.chapter}.${label}`,
                      url: vedabaseUrl(row.chapter, row.verse_label, row.verse),
                    },
                  ];
                })
              ).values()
            )
          : []);

      if (answer) {
        setMessages((m) => [...m, { role: "assistant", text: answer, sources }]);
      } else if (rows.length) {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `Here are related verses (${rows.length}).`,
            rows,
          },
        ]);
      } else {
        setMessages((m) => [...m, { role: "assistant", text: "No passages found." }]);
      }
    } catch (err: any) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` }]);
    } finally {
      setLoading(false);
    }
  }

  /* ---------------- Landing (full-screen wallpaper, covers TopNav) ---------------- */
  if (showSplash) {
    return (
      <div
        className="fixed inset-0 z-[200] select-none"
        role="button"
        aria-label="Enter chat"
        onClick={() => setShowSplash(false)}
      >
        {/* Layer 1: blurred cover to fill every screen without visible crop gaps */}
        <Image
          src={landing}
          alt="Śrīla Prabhupāda"
          fill
          priority
          className="object-cover blur-[6px] scale-105"
        />
        <div className="absolute inset-0 bg-black/25" />

        {/* Layer 2: the same image 'contain' so the whole photo is visible (no cropping) */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Image
            src={landing}
            alt=""
            fill
            className="object-contain"
          />
        </div>

        {/* Bottom-center CTA */}
        <div className="absolute inset-x-0 bottom-0 pb-14 flex justify-center">
          <div className="landing-cta text-white text-center px-5">
            <h1 className="text-4xl sm:text-5xl font-extrabold leading-tight drop-shadow-xl">
              Do you have questions for Śrīla Prabhupāda?
            </h1>
            <p className="mt-3 text-base sm:text-lg text-white/90 drop-shadow">
              Click anywhere to enter the discussion.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- Chat view with collapsible rail ---------------- */
  return (
    <div className="h-[calc(100dvh-4rem)] relative">
      {/* Left rail (ChatGPT-style): collapses to 56px, expands to 300px */}
      <aside
        className={[
          "absolute top-0 bottom-0 left-0 transition-all duration-200 ease-out",
          sidebarOpen ? "w-[300px]" : "w-14",
        ].join(" ")}
      >
        <div className="h-full bg-white/85 backdrop-blur border-r border-black/10 shadow-sm flex flex-col">
          {/* Header row */}
          <div className="flex items-center justify-between p-3">
            {sidebarOpen ? <strong className="text-sm">Chats</strong> : <span className="sr-only">Chats</span>}
            <div className="flex gap-2">
              <button
                className="btn-pill"
                title={sidebarOpen ? "New chat" : "New"}
                onClick={() => {
                  // simple session reset
                  setMessages([
                    {
                      role: "assistant",
                      text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
                    },
                  ]);
                }}
              >
                {sidebarOpen ? "New" : (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
              </button>
              <button
                className="btn-pill"
                onClick={() => setSidebarOpen((v) => !v)}
                title={sidebarOpen ? "Hide history" : "Show history"}
              >
                {sidebarOpen ? "Hide" : (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h16M4 12h10M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* List (placeholder single session) */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-2">
              <div className="rounded-xl border border-black/10 bg-white/90 p-3 mt-2">
                <div className="flex items-center gap-2 text-sm">
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path d="M12 6l4 4H8l4-4zm0 12l-4-4h8l-4 4z" fill="currentColor" />
                  </svg>
                  <span className="truncate">New chat</span>
                </div>
                {sidebarOpen && <div className="mt-1 text-xs text-gray-600">{new Date().toLocaleDateString()}</div>}
              </div>
            </div>

            {/* When collapsed, show a slim icon stack like ChatGPT */}
            {!sidebarOpen && (
              <div className="mt-4 flex flex-col items-center gap-5 text-gray-700">
                {/* write */}
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path d="M4 17.5V20h2.5L18 8.5l-2.5-2.5L4 17.5zM20.7 7.04a1 1 0 000-1.41L18.37 3.3a1 1 0 00-1.41 0l-1.34 1.34 2.5 2.5 1.34-1.34z" fill="currentColor"/>
                </svg>
                {/* search */}
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path d="M10 18a8 8 0 105.29-14.29A8 8 0 0010 18zm0 0l6 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/>
                </svg>
                {/* settings */}
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" fill="currentColor"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V22a2 2 0 11-4 0v-.07A1.65 1.65 0 008.1 20.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06c.46-.46.6-1.14.33-1.82A1.65 1.65 0 003 12.07V12a2 2 0 114 0v.07c0 .6.36 1.14.92 1.38.56.23 1.2.1 1.63-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82z" fill="currentColor"/>
                </svg>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Chat area */}
      <div className={["h-full pl-14 transition-all duration-200", sidebarOpen ? "md:pl-[300px]" : "md:pl-14"].join(" ")}>
        <section className="h-full min-h-0 flex flex-col rounded-3xl bg-white/85 backdrop-blur border border-black/5 shadow-xl mx-3 my-3">
          <div className="p-4 sm:p-6 border-b border-black/5">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
            <p className="mt-1 sm:mt-2 text-[0.95rem] sm:text-base text-gray-700">
              Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
            </p>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={[
                    "max-w-[92%] sm:max-w-[85%] rounded-2xl px-3 py-2 text-[0.98rem] leading-6 whitespace-pre-wrap shadow-sm",
                    m.role === "user"
                      ? "bg-orange-500 text-white rounded-br-sm"
                      : "bg-white text-gray-900 border border-black/5 rounded-bl-sm",
                  ].join(" ")}
                >
                  <p>{m.text}</p>

                  {"sources" in m && m.sources && m.sources.length > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-gray-700">Sources (Vedabase)</summary>
                      <ul className="mt-2 space-y-1 text-sm">
                        {m.sources.map((s, j) => (
                          <li key={j}>
                            <a className="text-orange-600 hover:underline" href={s.url} target="_blank" rel="noopener noreferrer">
                              {s.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  {"rows" in m && m.rows?.length && !("sources" in m) ? (
                    <ul className="mt-3 space-y-3">
                      {m.rows.map((row, idx) => {
                        const label = row.verse_label ?? String(row.verse);
                        return (
                          <li key={idx} className="border rounded-lg p-3">
                            <div className="text-xs text-gray-600">
                              {row.work} {row.chapter}.{label} · score {(row.rank ?? 0).toFixed(3)}
                            </div>
                            {row.translation && <p className="mt-1">{row.translation}</p>}
                            {row.purport && (
                              <details className="mt-2">
                                <summary className="cursor-pointer">Purport</summary>
                                <p className="mt-1 whitespace-pre-wrap">{row.purport}</p>
                              </details>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <form onSubmit={onSend} className="p-3 sm:p-4 bg-white/80 backdrop-blur border-t border-black/5">
            <div className="flex items-center gap-2">
              <input
                suppressHydrationWarning
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your question…"
                className="flex-1 rounded-xl border border-black/10 bg-white/95 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-400"
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl px-4 py-3 bg-orange-500 text-white font-medium hover:bg-orange-600 active:translate-y-[1px] shadow disabled:opacity-50"
              >
                {loading ? "Thinking…" : "Send"}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-600">
              Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}
