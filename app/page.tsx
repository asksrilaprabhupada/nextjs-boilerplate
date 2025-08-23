'use client';

import Image from 'next/image';
import { useState, useRef, useEffect, FormEvent } from 'react';

type Msg = { role: 'user' | 'assistant'; text: string };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      text:
        "Hare Kṛṣṇa! Ask anything. Replies here are grounded in Vaiṣṇava literatures (e.g., Bhagavad-gītā As It Is, Śrīmad-Bhāgavatam, Caitanya-caritāmṛta) — no speculation.",
    },
  ]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function onSend(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setInput('');

    // Placeholder reply so the UI feels real.
    // Later, replace this with a call to your /api/answer.
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text:
            "Preview reply (UI only). Next step is wiring this to your retrieval API so answers come strictly from your uploaded texts.",
        },
      ]);
    }, 250);
  }

  return (
    <main className="h-screen grid place-items-center bg-gradient-to-br from-[#FFF7EA] to-[#EDE6FF] px-6 py-10">
      <div className="mx-auto max-w-6xl grid gap-10 md:grid-cols-2 items-center">
        {/* LEFT: Prabhupāda photo */}
        <section className="relative aspect-[4/5] md:aspect-auto md:h-[560px] rounded-3xl overflow-hidden shadow-2xl ring-1 ring-black/5">
          <Image
            src="/prabhupada-left.jpg"  // <-- put your file in /public with this name
            alt="Śrīla Prabhupāda"
            fill
            sizes="(max-width: 768px) 100vw, 50vw"
            className="object-cover object-center"
            priority
          />
        </section>

        {/* RIGHT: Chat card */}
        <section className="relative rounded-3xl bg-white/75 backdrop-blur border border-black/5 shadow-xl h-full flex flex-col">
          {/* Header */}
          <div className="p-6 sm:p-8 border-b border-black/5">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
              Ask Śrīla Prabhupāda
            </h1>
            <p className="mt-2 text-sm sm:text-base text-gray-700">
              Answers sourced entirely from <span className="font-semibold">Vaiṣṇava literatures</span>.
              No speculation. (BG, SB, CC… more to be added.)
            </p>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="h-[420px] overflow-y-auto p-4 sm:p-6 space-y-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={[
                    'max-w-[85%] rounded-2xl px-3 py-2 text-[0.95rem] leading-6 shadow-sm',
                    m.role === 'user'
                      ? 'bg-orange-500 text-white rounded-br-sm'
                      : 'bg-white text-gray-900 border border-black/5 rounded-bl-sm',
                  ].join(' ')}
                >
                  {m.text}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <form onSubmit={onSend} className="sticky bottom-0 p-4 sm:p-6 bg-white/70 backdrop-blur rounded-b-3xl border-t border-black/5">
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
            <p className="mt-2 text-xs text-gray-500">
              Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.
            </p>
          </form>
        </section>
      </div>
    </main>
  );
}
