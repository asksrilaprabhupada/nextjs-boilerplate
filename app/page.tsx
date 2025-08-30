'use client';

import Image from "next/image";
import { useEffect, useRef, useState, FormEvent } from "react";

type Msg = { role: "user" | "assistant"; text: string };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text:
        "Hare Kṛṣṇa! Ask anything. Replies are grounded in Vaiṣṇava literatures (Bhagavad-gītā, Śrīmad-Bhāgavatam, etc.).",
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
      // call our server API which does embeddings + Supabase RPC search
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, k: 5 }),
      });
      const data = await r.json();

      if (!r.ok) throw new Error(data?.error || "Search failed");

      // format results into a readable assistant message
      const rows: any[] = data.rows || [];
      const text =
        rows.length === 0
          ? "No verses found."
          : rows
              .map(
                (row: any, i: number) =>
                  `(${i + 1}) BG ${row.chapter}.${row.verse}\n` +
                  `${row.translation ?? ""}` +
                  `${row.purport ? `\n— Purport (excerpt): ${row.purport.slice(0, 220)}…` : ""}`
              )
              .join("\n\n");

      setMessages((m) => [...m, { role: "assistant", text }]);
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full">
      <div className="mx-auto max-w-6xl h-full min-h-0 grid gap-8 md:grid-cols-2 items-stretch px-6 py-6">
        {/* LEFT: photo */}
        <section className="h-full rounded-3xl overflow-hidden shadow-2xl ring-1 ring-black/5 bg-white">
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

        {/* RIGHT: chat */}
        <section className="h-full min-h-0 flex flex-col rounded-3xl bg-white/75 backdrop-blur border border-black/5 shadow-xl">
          <div className="p-6 sm:p-8 border-b border-black/5">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
            <p className="mt-2 text-sm sm:text-base text-gray-700">
              Answers sourced entirely from <span className="font-semibold">Vaiṣṇava literatures</span>. No speculation.
            </p>
          </div>

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
                  {m.text}
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={onSend} className="p-4 sm:p-6 bg-white/70 backdrop-blur border-t border-black/5">
            <div className="flex items-center gap-2">
              <input
                suppressHydrationWarning
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="e.g., What does Chapter 15 say about the Supreme Person?"
                className="flex-1 rounded-xl border border-black/10 bg-white/90 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-400"
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl px-4 py-3 bg-orange-500 text-white font-medium hover:bg-orange-600 disabled:opacity-50"
              >
                {loading ? "Searching…" : "Send"}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.</p>
          </form>
        </section>
      </div>
    </div>
  );
}
