'use client';

import Image from "next/image";
import { useEffect, useRef, useState, FormEvent } from "react";

type Msg = { role: "user" | "assistant"; text: string };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text:
        "Hare Kṛṣṇa! Ask anything. Replies here are grounded in Vaiṣṇava literatures (e.g., Bhagavad-gītā As It Is, Śrīmad-Bhāgavatam, Caitanya-caritāmṛta) — no speculation.",
    },
  ]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function onSend(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");

    // Placeholder reply (UI only). Replace with API call later.
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        { 
          role: "assistant", 
          text: "Hare Kṛṣṇa! Śrīla Prabhupāda is blessing this service — the library is being prepared. Answers will come strictly from Vaiṣṇava literatures once the texts are uploaded. Please keep faith; we’ll be live very soon." },
      ]);
    }, 250);
  }

  return (
    <div className="h-full">
      {/* Two columns that fill the whole viewport below the header */}
      <div className="mx-auto max-w-6xl h-full min-h-0 grid gap-8 md:grid-cols-2 items-stretch px-6 py-6">
        {/* LEFT: fixed photo (never scrolls) */}
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

        {/* RIGHT: chat card fills column and only messages scroll */}
        <section className="h-full min-h-0 flex flex-col rounded-3xl bg-white/75 backdrop-blur border border-black/5 shadow-xl">
          {/* Header */}
          <div className="p-6 sm:p-8 border-b border-black/5">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
            <p className="mt-2 text-sm sm:text-base text-gray-700">
              Answers sourced entirely from <span className="font-semibold">Vaiṣṇava literatures</span>.
              No speculation. (BG, SB, CC… more to be added.)
            </p>
          </div>

          {/* Messages — the ONLY scrollable area */}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={[
                    "max-w-[85%] rounded-2xl px-3 py-2 text-[0.95rem] leading-6 shadow-sm",
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

          {/* Input */}
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
                className="rounded-xl px-4 py-3 bg-orange-500 text-white font-medium hover:bg-orange-600 active:translate-y-[1px] shadow"
              >
                Send
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.</p>
          </form>
        </section>
      </div>
    </div>
  );
}
