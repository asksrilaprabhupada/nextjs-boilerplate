"use client";

import Image from "next/image";
import { useEffect, useRef, useState, FormEvent } from "react";

type Row = {
  work: string;
  chapter: number;
  verse: number;
  verse_label: string | null;
  translation: string | null;
  purport: string | null;
  rank: number;
};

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; rows?: Row[] };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text:
        "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showChat, setShowChat] = useState(false); // <-- mobile enter gate
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function runSearch(q: string) {
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setLoading(true);

    try {
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, k: 5 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Search failed");

      const rows: Row[] = data.rows || [];
      const text = rows.length
        ? `Top results (${rows.length}):`
        : "No passages found. Try a different phrase or keyword.";

      setMessages((m) => [...m, { role: "assistant", text, rows }]);
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;
    await runSearch(q);
  }

  /** Shared chat UI (used in desktop and mobile) */
  function ChatPanel() {
    return (
      <section className="h-full min-h-0 flex flex-col rounded-3xl bg-white/75 backdrop-blur border border-black/5 shadow-xl">
        {/* Header */}
        <div className="p-6 sm:p-8 border-b border-black/5">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
          <p className="mt-2 text-sm sm:text-base text-gray-700">
            Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
          </p>

          {/* Quick chip */}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="rounded-full bg-orange-500/10 text-orange-700 border border-orange-300 px-3 py-1 text-sm hover:bg-orange-500/15"
              onClick={() => runSearch("Bhagavad-gita 15.1")}
              disabled={loading}
            >
              Bhagavad-gītā 15.1
            </button>
          </div>
        </div>

        {/* Messages — scrollable */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={[
                  "max-w-[85%] rounded-2xl px-3 py-2 text-[0.95rem] leading-6 whitespace-pre-wrap shadow-sm",
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
        <form onSubmit={onSend} className="p-4 sm:p-6 bg-white/70 backdrop-blur border-t border-black/5">
          <div className="flex items-center gap-2">
            <input
              suppressHydrationWarning
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g., 'field of activities', 'three modes of nature', 'false ego'"
              className="flex-1 rounded-xl border border-black/10 bg-white/90 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-400"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl px-4 py-3 bg-orange-500 text-white font-medium hover:bg-orange-600 active:translate-y-[1px] shadow disabled:opacity-50"
            >
              {loading ? "Searching…" : "Send"}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to search.</p>
        </form>
      </section>
    );
  }

  return (
    <div className="h-full">
      {/* MOBILE: Landing (full photo + CTA). Hidden once user taps Enter */}
      <section className={`${showChat ? "hidden" : "block"} md:hidden h-full relative overflow-hidden rounded-none`}>
        <Image
          src="/prabhupada-left.jpg"
          alt="Śrīla Prabhupāda"
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
        <div className="absolute inset-x-0 bottom-10 px-6 flex justify-center">
          <button
            onClick={() => setShowChat(true)}
            className="rounded-full bg-white/90 px-6 py-3 text-sm font-medium shadow-lg border border-black/10"
          >
            Tap to enter
          </button>
        </div>
      </section>

      {/* MOBILE: Chat-only view (after Enter) */}
      <div className={`${showChat ? "block" : "hidden"} md:hidden h-full px-4 py-4`}>
        <ChatPanel />
      </div>

      {/* DESKTOP/TABLET: Two-column layout always visible */}
      <div className="hidden md:grid mx-auto max-w-6xl h-full min-h-0 grid-cols-2 gap-8 items-stretch px-6 py-6">
        {/* LEFT: fixed photo */}
        <section className="h-full rounded-3xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-white">
          <div className="relative h-full w-full p-2 sp-hero-in">
            <div className="h-full w-full relative sp-hero-breathe">
              <Image
                src="/prabhupada-left.jpg"
                alt="Śrīla Prabhupāda"
                fill
                sizes="(max-width: 768px) 100vw, 50vw"
                className="object-cover object-center"
                priority
              />
            </div>
          </div>
        </section>

        {/* RIGHT: chat card */}
        <ChatPanel />
      </div>
    </div>
  );
}
