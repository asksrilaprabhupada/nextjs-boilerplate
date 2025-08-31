// app/page.tsx
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
  // Mobile: start on landing; Desktop: go straight to chat
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth >= 768) setEntered(true);
  }, []);

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

  // ----------------- MOBILE LANDING (no scroll) -----------------
  if (!entered) {
    return (
      <div className="md:hidden h-full">
        <button
          onClick={() => setEntered(true)}
          className="relative h-full w-full overflow-hidden focus:outline-none"
          aria-label="Enter"
        >
          <Image
            src="/prabhupada-left.jpg"
            alt="Śrīla Prabhupāda"
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
          {/* soft gradient + instruction */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-black/0 to-black/0" />
          <div className="absolute inset-x-0 bottom-10 text-center">
            <div className="inline-block rounded-full bg-white/85 px-4 py-2 text-sm shadow">
              Tap anywhere to enter
            </div>
          </div>
        </button>
      </div>
    );
  }

  // ----------------- CHAT UI -----------------
  return (
    <div className="h-full">
      <div className="mx-auto max-w-6xl h-full min-h-0 grid gap-8 md:grid-cols-2 items-stretch px-4 sm:px-6 py-6">
        {/* LEFT: photo — hidden on mobile once entered */}
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

        {/* RIGHT: chat card fills column and only messages scroll */}
        <section className="h-full min-h-0 flex flex-col rounded-3xl bg-white/80 backdrop-blur border border-black/5 shadow-xl">
          {/* Header */}
          <div className="p-5 sm:p-7 border-b border-black/5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
            <p className="mt-2 text-sm sm:text-base text-gray-700">
              Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
            </p>
          </div>

          {/* Messages — ONLY scrollable area */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={[
                    "max-w-[90%] rounded-2xl px-3 py-2 text-[0.95rem] leading-6 whitespace-pre-wrap shadow-sm",
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
            <p className="mt-2 text-xs text-gray-500">
              Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to search.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}
