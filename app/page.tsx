"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState, FormEvent } from "react";

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

type Chat = { id: string; title: string; createdAt: number; messages: Msg[] };

const HERO_IMAGES = [
  "/landing/prabhupada-1.jpg",
  "/landing/prabhupada-2.jpg",
  "/landing/prabhupada-3.jpg",
  "/landing/prabhupada-4.jpg",
  "/landing/prabhupada-5.jpg",
];

function vedabaseUrl(chapter: number, verse_label: string | null, verse: number) {
  const label = (verse_label || String(verse)).replace(/[^\d-]/g, "");
  return `https://vedabase.io/en/library/bg/${chapter}/${label}/`;
}

const LS_KEY = "sp_chats_v1";

export default function Home() {
  /** -------------------- Landing (hero) -------------------- */
  const [showHero, setShowHero] = useState(true);

  // pick a random hero image on first render
  const heroSrc = useMemo(
    () => HERO_IMAGES[Math.floor(Math.random() * HERO_IMAGES.length)],
    []
  );

  /** -------------------- Chat state -------------------- */
  const [showHistory, setShowHistory] = useState(true); // collapsible sidebar
  const [chats, setChats] = useState<Chat[]>(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : null;
      if (raw) return JSON.parse(raw) as Chat[];
    } catch {}
    return [
      {
        id: crypto.randomUUID(),
        title: "New chat",
        createdAt: Date.now(),
        messages: [
          {
            role: "assistant",
            text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
          },
        ],
      },
    ];
  });
  const [activeId, setActiveId] = useState<string>(chats[0]?.id);
  const active = chats.find((c) => c.id === activeId)!;

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(chats));
  }, [chats]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const chatTopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [active?.messages]);

  useEffect(() => {
    if (!showHero) setTimeout(() => chatTopRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, [showHero]);

  function setActiveMessages(updater: (prev: Msg[]) => Msg[]) {
    setChats((all) =>
      all.map((c) => (c.id === activeId ? { ...c, messages: updater(c.messages) } : c))
    );
  }

  function newChat() {
    const c: Chat = {
      id: crypto.randomUUID(),
      title: "New chat",
      createdAt: Date.now(),
      messages: [
        {
          role: "assistant",
          text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
        },
      ],
    };
    setChats((p) => [c, ...p]);
    setActiveId(c.id);
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    setActiveMessages((m) => [...m, { role: "user", text: q }]);
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
                    { label: `BG ${row.chapter}.${label}`, url: vedabaseUrl(row.chapter, row.verse_label, row.verse) },
                  ];
                })
              ).values()
            )
          : []);

      if (answer) {
        setActiveMessages((m) => [...m, { role: "assistant", text: answer, sources }]);
      } else if (rows.length) {
        setActiveMessages((m) => [
          ...m,
          { role: "assistant", text: `Here are related verses (${rows.length}).`, rows },
        ]);
      } else {
        setActiveMessages((m) => [...m, { role: "assistant", text: "No passages found." }]);
      }
    } catch (err: any) {
      setActiveMessages((m) => [...m, { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` }]);
    } finally {
      setLoading(false);
    }
  }

  /** -------------------- UI -------------------- */
  return (
    <div className="h-[calc(100dvh-4rem)] relative">
      {/* ======== Landing (covers the whole UI, no nav/history showing) ======== */}
      {showHero && (
        <div
          className="fixed inset-0 z-[9999] select-none"
          onClick={() => setShowHero(false)}
          role="button"
          aria-label="Enter chat"
        >
          {/* Blurred fill so there is never empty space */}
          <div
            className="absolute inset-0 bg-center bg-cover blur-2xl scale-[1.08] opacity-50"
            style={{ backgroundImage: `url(${heroSrc})` }}
          />
          {/* Actual photo: never cropped */}
          <Image src={heroSrc} alt="Śrīla Prabhupāda" fill priority className="object-contain z-10" />
          {/* Bottom gradient for legibility */}
          <div className="absolute inset-0 z-20 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          {/* Bottom-center card */}
          <div className="absolute z-30 inset-x-0 bottom-10 flex justify-center px-4">
            <div className="max-w-4xl w-full rounded-3xl bg-black/55 backdrop-blur-md ring-1 ring-white/10 p-6 sm:p-8 sp-hero-in sp-hero-breathe">
              <h1 className="text-white text-3xl sm:text-5xl font-extrabold tracking-tight text-center">
                Do you have questions for Śrīla Prabhupāda?
              </h1>
              <p className="mt-3 text-white/85 text-center text-sm sm:text-base">
                Click anywhere to enter the discussion.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ======== Chat layout (history + chat) ======== */}
      <div className="mx-auto max-w-6xl h-full min-h-0 grid grid-cols-[auto,1fr] gap-4 px-4 sm:px-6 py-4">
        {/* History Sidebar (collapsible) */}
        <aside
          className={[
            "relative h-full rounded-3xl bg-white/85 backdrop-blur border border-black/5 shadow-xl transition-all duration-200",
            showHistory ? "w-72 opacity-100" : "w-0 opacity-0 overflow-hidden",
          ].join(" ")}
        >
          {showHistory && (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between p-3 border-b border-black/5">
                <h2 className="text-sm font-semibold">Chats</h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={newChat}
                    className="rounded-full bg-orange-500 text-white text-xs px-3 py-1.5 hover:bg-orange-600"
                  >
                    New
                  </button>
                  <button
                    onClick={() => setShowHistory(false)}
                    className="rounded-full border px-3 py-1.5 text-xs hover:bg-gray-50"
                  >
                    Hide
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {chats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setActiveId(c.id)}
                    className={[
                      "w-full text-left rounded-xl px-3 py-2 border",
                      c.id === activeId ? "bg-orange-50 border-orange-200" : "bg-white hover:bg-gray-50",
                    ].join(" ")}
                  >
                    <div className="text-[13px] font-medium">{c.title}</div>
                    <div className="text-[11px] text-gray-500">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Chat Card */}
        <section
          ref={chatTopRef}
          className="h-full min-h-0 flex flex-col rounded-3xl bg-white/85 backdrop-blur border border-black/5 shadow-xl"
        >
          <div className="p-4 sm:p-6 border-b border-black/5">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
            <p className="mt-1 sm:mt-2 text-[0.95rem] sm:text-base text-gray-700">
              Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
            </p>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
            {active?.messages.map((m, i) => (
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

                  {/* Narrative answers: show Vedabase links only */}
                  {"sources" in m && (m as any).sources?.length ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-gray-700">Sources (Vedabase)</summary>
                      <ul className="mt-2 space-y-1 text-sm">
                        {(m as any).sources.map((s: SourceLink, j: number) => (
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

                  {/* Legacy fallback: only show cards if there is NO narrative */}
                  {"rows" in m && (m as any).rows?.length && !("sources" in m) ? (
                    <ul className="mt-3 space-y-3">
                      {(m as any).rows.map((row: Row, idx: number) => {
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

      {/* Floating pill to reopen history when hidden */}
      {!showHistory && !showHero && (
        <button
          onClick={() => setShowHistory(true)}
          className="fixed z-[60] left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 backdrop-blur border border-black/10 shadow px-3 py-2 text-sm hover:bg-white"
          aria-label="Show history"
          title="Show history"
        >
          History
        </button>
      )}
    </div>
  );
}
