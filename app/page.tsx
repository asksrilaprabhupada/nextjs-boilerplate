"use client";

import Image from "next/image";
import { useEffect, useRef, useState, FormEvent } from "react";

/* --- Types --------------------------------------------------------------- */
type Row = {
  work: string;
  chapter: number;
  verse: number;
  verse_label: string | null;
  translation: string | null;
  purport: string | null;
  rank?: number;
};

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; rows?: Row[] };

/* --- Component ----------------------------------------------------------- */
export default function Home() {
  const [showSplash, setShowSplash] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const chatTopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!showSplash) setTimeout(() => chatTopRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, [showSplash]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);

    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, k: 8 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Search failed");

      const rows: Row[] = data.rows || [];
      const answer: string = data.answer || (rows.length ? "Here are related verses." : "No passages found.");

      setMessages((m) => [...m, { role: "assistant", text: answer, rows }]);
    } catch (err: any) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-6xl h-full min-h-0 grid gap-6 md:grid-cols-2 items-stretch px-4 sm:px-6 py-4">
        {/* LEFT: Photo (desktop) */}
        <section className="hidden md:block h-full rounded-3xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-white">
          <div className="relative h-full w-full p-2">
            <Image
              src="/prabhupada-left.jpg"
              alt="Śrīla Prabhupāda"
              fill
              sizes="(max-width: 768px) 100vw, 50vw"
              className="object-cover object-center"
              priority
            />
          </div>
        </section>

        {/* RIGHT: Chat */}
        <section ref={chatTopRef} className="h-full min-h-0 flex flex-col rounded-3xl bg-white/85 backdrop-blur border border-black/5 shadow-xl">
          <div className="p-4 sm:p-6 border-b border-black/5">
            <h1 className="hidden md:block text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
            <p className="mt-1 sm:mt-2 text-[0.95rem] sm:text-base text-gray-700">
              Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
            </p>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
            {/* Example chip */}
            <div className="inline-flex items-center">
              <span className="rounded-full bg-orange-500 text-white px-4 py-2 text-sm">Bhagavad Gita Chapter 15 verse 1</span>
            </div>

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

                  {"rows" in m && m.rows?.length ? (
                    <ul className="mt-3 space-y-3">
                      {m.rows.map((row, idx) => {
                        const label = row.verse_label ?? String(row.verse);
                        return (
                          <li key={idx} className="border rounded-lg p-3">
                            <div className="text-xs text-gray-600">
                              {row.work} {row.chapter}.{label}
                              {row.rank != null ? <> · score {(row.rank ?? 0).toFixed(3)}</> : null}
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
                {loading ? "Searching…" : "Send"}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-600">
              Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.
            </p>
          </form>
        </section>
      </div>

      {/* MOBILE SPLASH */}
      {showSplash && (
        <div
          className="md:hidden fixed z-50 inset-x-0 bottom-0 top-16"
          onClick={() => setShowSplash(false)}
          role="button"
          aria-label="Tap to start asking"
        >
          <Image src="/prabhupada-left.jpg" alt="Śrīla Prabhupāda" fill priority className="object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-6 text-center select-none">
            <p className="text-white/90 text-lg font-medium drop-shadow">Tap anywhere to ask me anything</p>
            <p className="mt-1 text-white/70 text-xs drop-shadow">Answers from Vaiṣṇava literatures</p>
          </div>
        </div>
      )}
    </div>
  );
}
