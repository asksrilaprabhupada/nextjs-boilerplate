"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";

/** DB row returned by /api/search (Supabase RPC) */
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

  // the messages list is the ONLY scrollable area
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  /** Send the current input (or an override) */
  async function send(qOverride?: string) {
    const q = (qOverride ?? input).trim();
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
      const header = rows.length
        ? `Top results (${rows.length}):`
        : "No passages found. Try a different phrase or keyword.";

      setMessages((m) => [...m, { role: "assistant", text: header, rows }]);
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  return (
    <div className="h-full">
      {/* Layout: one column on mobile, two on desktop */}
      <div className="mx-auto max-w-6xl h-full min-h-0 grid md:grid-cols-2 gap-4 sm:gap-6 px-3 sm:px-6 py-3 sm:py-6">
        {/* LEFT: Srila Prabhupada photo (top on mobile) */}
        <section className="rounded-3xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-white">
          <div className="relative aspect-[3/4] w-full md:aspect-auto md:h-full p-2">
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

        {/* RIGHT: chat card – header + scrollable messages + fixed input */}
        <section className="h-full min-h-0 flex flex-col rounded-3xl bg-white/80 backdrop-blur border border-black/5 shadow-xl">
          {/* Card header */}
          <div className="p-4 sm:p-6 border-b border-black/5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">
              Ask Śrīla Prabhupāda
            </h1>
            <p className="mt-1 sm:mt-2 text-sm sm:text-base text-gray-700">
              Answers come directly from{" "}
              <span className="font-semibold">Vaiṣṇava literatures</span>.
            </p>

            {/* Quick suggestion chip */}
            <div className="mt-3">
              <button
                type="button"
                onClick={() => send("Bhagavad Gita Chapter 15 verse 1")}
                className="inline-flex items-center rounded-full bg-orange-500 text-white text-sm px-4 py-2 shadow hover:bg-orange-600 active:translate-y-[1px]"
              >
                Bhagavad Gita Chapter 15 verse 1
              </button>
            </div>
          </div>

          {/* Messages – ONLY this scrolls */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 space-y-4"
          >
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={[
                    "max-w-[88%] sm:max-w-[85%] rounded-2xl px-3 py-2 text-[0.95rem] leading-6 whitespace-pre-wrap shadow-sm",
                    m.role === "user"
                      ? "bg-orange-500 text-white rounded-br-sm"
                      : "bg-white text-gray-900 border border-black/5 rounded-bl-sm",
                  ].join(" ")}
                >
                  <p>{m.text}</p>

                  {/* Render results if present */}
                  {"rows" in m && m.rows?.length ? (
                    <ul className="mt-3 space-y-3">
                      {m.rows.map((row, idx) => {
                        const label = row.verse_label ?? String(row.verse);
                        return (
                          <li key={idx} className="border rounded-lg p-3">
                            <div className="text-xs text-gray-600">
                              {row.work} {row.chapter}.{label} · score{" "}
                              {(row.rank ?? 0).toFixed(3)}
                            </div>
                            {row.translation && (
                              <p className="mt-1">{row.translation}</p>
                            )}
                            {row.purport && (
                              <details className="mt-2">
                                <summary className="cursor-pointer">Purport</summary>
                                <p className="mt-1 whitespace-pre-wrap">
                                  {row.purport}
                                </p>
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

          {/* Input – fixed inside the card; visible on mobile; not scrolling */}
          <form
            onSubmit={onSubmit}
            className="
              p-3 sm:p-4 bg-white/95 backdrop-blur
              border-t border-black/5
              pb-[max(0px,env(safe-area-inset-bottom))]
            "
          >
            <div className="flex items-center gap-2">
              <input
                suppressHydrationWarning
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your question…"
                className="
                  flex-1 rounded-xl border border-black/10 bg-white
                  px-4 py-3 outline-none
                  focus:ring-2 focus:ring-orange-400
                  placeholder:text-gray-500
                "
              />
              <button
                type="submit"
                disabled={loading}
                className="
                  rounded-xl px-4 py-3 bg-orange-500 text-white font-medium
                  hover:bg-orange-600 active:translate-y-[1px] shadow
                  disabled:opacity-50
                "
              >
                {loading ? "…" : "Send"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}
