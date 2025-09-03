"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState, FormEvent } from "react";

/* ----------------------- Types (unchanged) ----------------------- */
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

/* ----------------------- Helpers ----------------------- */
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

/* ----------------------- Page ----------------------- */
export default function Home() {
  /* splash */
  const [showSplash, setShowSplash] = useState(true);
  const randomIdx = useMemo(() => Math.floor(Math.random() * LANDING_IMAGES.length), []);
  const splashImg = LANDING_IMAGES[randomIdx];

  /* chat + history */
  const [historyOpen, setHistoryOpen] = useState(true);

  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

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
      // Prefer narrative endpoint; fallback to bare search if not found
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

  /* ----------------------- UI ----------------------- */
  return (
    <div className="h-[calc(100dvh-4rem)]"> {/* fills under the navbar */}
      {/* ---------- FULLSCREEN SPLASH (covers everything) ---------- */}
      {showSplash && (
        <div
          className="fixed inset-0 z-[200] cursor-pointer"
          onClick={() => setShowSplash(false)}
          aria-label="Enter the discussion"
        >
          {/* Image: never crop -> use contain; add subtle zoom breathing */}
          <Image
            src={splashImg}
            alt="Śrīla Prabhupāda"
            fill
            priority
            className="object-contain bg-black sp-hero-in sp-hero-breathe"
          />
          {/* dark radial + top gradient for contrast */}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.25),rgba(0,0,0,0.55))]" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/50 to-transparent" />

          {/* Bottom-center glass panel */}
          <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center px-4">
            <div className="max-w-4xl w-full rounded-3xl bg-black/45 backdrop-blur-md ring-1 ring-white/10 px-6 py-5 text-center">
              <h1 className="text-white font-extrabold tracking-tight text-4xl sm:text-5xl md:text-6xl">
                Do you have questions for Śrīla Prabhupāda?
              </h1>
              <p className="mt-3 text-white/85 text-base sm:text-lg">
                Click anywhere to enter the discussion.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ---------- CHAT AREA ---------- */}
      <div className="relative h-full min-h-0 flex">
        {/* Collapsed rail button (when history is closed) */}
        {!historyOpen && (
          <button
            onClick={() => setHistoryOpen(true)}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-[10] rounded-full border border-black/10 bg-white/90 px-3 py-2 shadow hover:bg-white"
            aria-label="Show history"
            title="Show history"
          >
            History
          </button>
        )}

        {/* History drawer */}
        <aside
          className={[
            "h-full transition-all duration-200 ease-out",
            historyOpen ? "w-[270px]" : "w-0",
          ].join(" ")}
        >
          <div
            className={[
              "h-full overflow-hidden",
              historyOpen ? "opacity-100" : "opacity-0 pointer-events-none",
            ].join(" ")}
          >
            <div className="h-full p-3 sm:p-4">
              <div className="rounded-2xl bg-white/90 backdrop-blur border border-black/10 shadow-md h-full flex flex-col">
                <div className="p-3 flex items-center justify-between border-b border-black/10">
                  <div className="font-semibold">Chats</div>
                  <div className="flex items-center gap-2">
                    <button className="rounded-full bg-orange-500 text-white text-sm px-3 py-1.5 shadow">
                      New
                    </button>
                    <button
                      className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
                      onClick={() => setHistoryOpen(false)}
                    >
                      Hide
                    </button>
                  </div>
                </div>

                {/* Simple stub list (kept minimal – you can wire real history later) */}
                <div className="p-3">
                  <div className="rounded-xl border border-black/10 px-3 py-2 bg-white/95">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="inline-block h-5 w-5 rounded border" />
                      <span>New chat</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {new Date().toLocaleDateString()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Chat column */}
        <section className="flex-1 min-w-0 h-full px-3 sm:px-4 py-3 sm:py-4">
          <div className="h-full min-h-0 rounded-3xl bg-white/85 backdrop-blur border border-black/5 shadow-xl flex flex-col">
            {/* Header */}
            <div className="p-4 sm:p-6 border-b border-black/5">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
              <p className="mt-1 sm:mt-2 text-[0.95rem] sm:text-base text-gray-700">
                Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
              </p>
            </div>

            {/* Messages (scroll area) */}
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

                    {/* Narrative answers: just show Vedabase links */}
                    {"sources" in m && m.sources && m.sources.length > 0 ? (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm text-gray-700">Sources (Vedabase)</summary>
                        <ul className="mt-2 space-y-1 text-sm">
                          {m.sources.map((s, j) => (
                            <li key={j}>
                              <a
                                className="text-orange-600 hover:underline"
                                href={s.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {s.label}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}

                    {/* Legacy fallback cards – only if no narrative */}
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
          </div>
        </section>
      </div>
    </div>
  );
}
