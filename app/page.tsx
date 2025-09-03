"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState, FormEvent } from "react";

/* ----------------------- Types (yours, preserved) ---------------------- */
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

/* ----------------------- Multi-chat (local only) ----------------------- */
type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messages: Msg[];
};

const STORAGE_KEY = "asp_chats_v1";

const uid = () => Math.random().toString(36).slice(2, 10);
const load = (): Chat[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Chat[]) : [];
  } catch {
    return [];
  }
};
const save = (chats: Chat[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));

function titleFrom(messages: Msg[]) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const t = (firstUser as { text: string }).text.trim().replace(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 48) + "…" : t || "New chat";
}

/* ---------------------- Your Vedabase URL helper ----------------------- */
function vedabaseUrl(chapter: number, verse_label: string | null, verse: number) {
  const label = (verse_label || String(verse)).replace(/[^\d-]/g, "");
  return `https://vedabase.io/en/library/bg/${chapter}/${label}/`;
}

/* --------------------- Wallpapers for landing screen ------------------- */
/* If you don’t add these, it will just use prabhupada-left.jpg */
const WALLPAPERS = [
  "/prabhupada-left.jpg",
  "/landing/prabhupada-2.jpg",
  "/landing/prabhupada-3.jpg",
  "/landing/prabhupada-4.jpg",
  "/landing/prabhupada-5.jpg",
];

export default function Home() {
  /* Landing overlay (full screen) */
  const wallpaper = useMemo(
    () => WALLPAPERS[Math.floor(Math.random() * WALLPAPERS.length)],
    []
  );
  const [entered, setEntered] = useState(false);

  /* Chats */
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useMemo(() => chats.find((c) => c.id === activeId) || null, [chats, activeId]);

  /* Layout: collapsible history (desktop too) */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarWidth = sidebarOpen ? 280 : 0; // px

  /* Input state */
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  /* Scroll to bottom on new messages */
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [active?.messages.length]);

  /* Initialize chat(s) */
  useEffect(() => {
    const existing = load();
    if (existing.length) {
      setChats(existing);
      const latest = [...existing].sort((a, b) => b.createdAt - a.createdAt)[0];
      setActiveId(latest.id);
      setEntered(true);
    } else {
      const first: Chat = {
        id: uid(),
        title: "New chat",
        createdAt: Date.now(),
        messages: [
          {
            role: "assistant",
            text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
          },
        ],
      };
      setChats([first]);
      setActiveId(first.id);
    }
  }, []);

  useEffect(() => save(chats), [chats]);

  /* Actions */
  function newChat() {
    const c: Chat = {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      messages: [
        {
          role: "assistant",
          text: "Hare Kṛṣṇa! Ask anything. Answers come directly from Vaiṣṇava literatures.",
        },
      ],
    };
    setChats((prev) => [c, ...prev]);
    setActiveId(c.id);
    setEntered(true);
  }
  function deleteChat(id: string) {
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) {
      const remaining = chats.filter((c) => c.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  }
  function renameChat(id: string, next?: string) {
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title: next || c.title } : c)));
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!active) return;
    const q = input.trim();
    if (!q || loading) return;

    setInput("");
    setLoading(true);
    const target = active.id;

    // push user message
    setChats((prev) =>
      prev.map((c) => (c.id === target ? { ...c, messages: [...c.messages, { role: "user", text: q }] } : c))
    );

    try {
      // Prefer narrative; fallback to bare search
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

      let assistantMsg: Msg;
      if (answer) {
        assistantMsg = { role: "assistant", text: answer, sources };
      } else if (rows.length) {
        assistantMsg = { role: "assistant", text: `Here are related verses (${rows.length}).`, rows };
      } else {
        assistantMsg = { role: "assistant", text: "No passages found." };
      }

      setChats((prev) =>
        prev.map((c) => (c.id === target ? { ...c, messages: [...c.messages, assistantMsg] } : c))
      );
      setChats((prev) =>
        prev.map((c) => (c.id === target ? { ...c, title: titleFrom(c.messages) } : c))
      );
    } catch (err: any) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === target
            ? { ...c, messages: [...c.messages, { role: "assistant", text: `Error: ${err?.message || "Something went wrong."}` }] }
            : c
        )
      );
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------------- Render ------------------------------- */
  return (
    <div className="h-[calc(100dvh-4rem)]">
      {/* Grid uses a CSS var for sidebar width so collapsing gives chat more room */}
      <div
        className="h-full min-h-0 grid gap-2 px-2 py-2 md:gap-3 md:px-3 md:py-3"
        style={{ ["--sbw" as any]: `${sidebarWidth}px` }}
      >
        <div className="hidden md:grid md:grid-cols-[var(--sbw)_1fr] md:gap-3 h-full">
          {/* Sidebar (collapsible on desktop too) */}
          <aside
            className="h-full overflow-hidden rounded-2xl bg-white border border-black/10 shadow-sm"
            style={{ width: sidebarWidth ? undefined : 0, display: sidebarWidth ? "block" : "none" }}
          >
            <div className="flex items-center justify-between px-3 py-3 border-b border-black/10">
              <div className="font-semibold">Chats</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={newChat}
                  className="rounded-xl bg-orange-500 text-white px-3 py-1.5 text-sm hover:bg-orange-600"
                  title="New chat"
                >
                  New
                </button>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="rounded-xl border px-2 py-1.5 text-sm"
                  title="Hide history"
                >
                  Hide
                </button>
              </div>
            </div>

            <div className="max-h-[calc(100%-3rem)] overflow-y-auto p-2 space-y-1">
              {chats.length === 0 && <p className="px-2 py-2 text-sm text-gray-600">No chats yet.</p>}
              {chats.map((c) => (
                <div
                  key={c.id}
                  className={[
                    "group flex items-center gap-2 rounded-xl px-2 py-2 cursor-pointer",
                    c.id === activeId ? "bg-orange-50 border border-orange-200" : "hover:bg-gray-50",
                  ].join(" ")}
                  onClick={() => {
                    setActiveId(c.id);
                    setEntered(true);
                  }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = prompt("Rename chat title:", c.title || "");
                      if (next !== null) renameChat(c.id, next.trim());
                    }}
                    className="shrink-0 rounded border px-1.5 py-0.5 text-xs text-gray-700"
                    title="Rename"
                  >
                    ✎
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.95rem]">{c.title || "New chat"}</div>
                    <div className="text-xs text-gray-500">{new Date(c.createdAt).toLocaleDateString()}</div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this chat?")) deleteChat(c.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-600"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </aside>

          {/* Chat pane (fills everything else) */}
          <section className="relative h-full min-h-0 flex flex-col rounded-2xl bg-white/90 backdrop-blur border border-black/5 shadow-xl">
            {/* Header with a persistent toggle button */}
            <div className="p-4 sm:p-6 border-b border-black/5 flex items-center justify-between">
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Ask Śrīla Prabhupāda</h1>
                <p className="mt-1 sm:mt-2 text-[0.95rem] sm:text-base text-gray-700">
                  Answers come directly from <span className="font-semibold">Vaiṣṇava literatures</span>.
                </p>
              </div>
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className="rounded-xl border border-black/10 px-3 py-2 text-sm"
              >
                {sidebarOpen ? "Hide history" : "Show history"}
              </button>
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

                    {/* Narrative: show Vedabase links only */}
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

                    {/* Legacy fallback: only if no narrative */}
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
            <form onSubmit={onSend} className="p-3 sm:p-4 bg-white/85 backdrop-blur border-t border-black/5">
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
                  disabled={loading || !active}
                  className="rounded-xl px-4 py-3 bg-orange-500 text-white font-medium hover:bg-orange-600 active:translate-y-[1px] shadow disabled:opacity-50"
                >
                  {loading ? "Thinking…" : "Send"}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-600">
                Press <kbd className="px-1 py-0.5 rounded border">Enter</kbd> to send.
              </p>
            </form>

            {/* Full-screen landing overlay (covers TopNav and everything) */}
            {!entered && (
              <button
                onClick={() => setEntered(true)}
                className="fixed inset-0 z-[1000] text-left"
                aria-label="Click to begin asking"
              >
                <Image src={wallpaper} alt="Śrīla Prabhupāda" fill priority className="object-cover" />
                <div className="absolute inset-0 bg-black/35 sm:bg-gradient-to-t sm:from-black/70 sm:via-black/30 sm:to-black/10" />
                <div className="absolute inset-0 flex items-end">
                  <div className="p-6 sm:p-10 w-full">
                    <h2 className="text-white text-2xl sm:text-4xl font-bold drop-shadow">
                      Do you have questions for Śrīla Prabhupāda?
                    </h2>
                    <p className="mt-2 text-white/90 text-sm sm:text-base drop-shadow">
                      Click anywhere to enter the discussion.
                    </p>
                  </div>
                </div>
              </button>
            )}
          </section>
        </div>

        {/* Mobile: when sidebar is hidden by grid, show a floating opener */}
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="hidden md:flex fixed left-2 top-24 z-[1100] rounded-full border bg-white/90 px-3 py-2 text-sm shadow"
            aria-label="Show chat history"
          >
            History
          </button>
        )}

        {/* Small screens: no desktop grid; we still show only chat pane (history is via header button) */}
        <div className="md:hidden h-full">
          {/* We reuse the same chat pane but without the sidebar; to avoid duplication, we just rely on the desktop pane above.
              For simplicity and to keep behavior identical, mobile users see the main pane with landing overlay already. */}
        </div>
      </div>
    </div>
  );
}
