// app/page.tsx
"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Row = {
  work: string;
  chapter: number;
  verse: number;
  verse_label: string | null;
  translation: string | null;
  purport: string | null;
  rank?: number;
};

type SearchHit = {
  id: string;
  ref: string;         // BG 2.13
  work: string;        // Bhagavad-gita As It Is
  section?: string;    // Translation / Purport
  type: "scripture" | "purport";
  snippet: string;
  url?: string;
};

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function useHotkey(key: string, handler: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler]);
}

function vedabaseUrl(chapter: number, verse_label: string | null, verse: number) {
  const label = (verse_label || String(verse)).replace(/[^\d-]/g, "");
  return `https://vedabase.io/en/library/bg/${chapter}/${label}/`;
}

function normalizeWhitespace(x: string) {
  let s = (x || "").replaceAll("\n", " ").replaceAll("\t", " ").trim();
  while (s.includes("  ")) s = s.replaceAll("  ", " ");
  return s.trim();
}

function clip(s: string, max: number) {
  const t = normalizeWhitespace(s);
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

function SoftBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[30rem] w-[30rem] -translate-x-1/2 rounded-full blur-3xl opacity-25 bg-gradient-to-br from-amber-300 via-orange-200 to-rose-200" />
      <div className="absolute -bottom-48 -left-40 h-[28rem] w-[28rem] rounded-full blur-3xl opacity-15 bg-gradient-to-br from-indigo-300 via-sky-200 to-emerald-200" />
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(0,0,0,.9) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="absolute left-0 top-24 h-px w-full bg-gradient-to-r from-transparent via-black/10 to-transparent" />
      <div className="absolute left-0 top-28 h-px w-full bg-gradient-to-r from-transparent via-black/5 to-transparent" />
    </div>
  );
}

function TopBar() {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
      <div className="flex items-center gap-3">
        <div className="relative grid h-10 w-10 place-items-center rounded-2xl bg-white/75 shadow-sm ring-1 ring-black/5 backdrop-blur">
          <div className="h-6 w-6 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-inner" />
          <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-gradient-to-br from-indigo-500 to-sky-400 shadow-sm" />
        </div>
        <div className="leading-tight">
          <div className="font-semibold tracking-tight text-zinc-900">askśrīlaprabhupāda</div>
          <div className="text-xs text-zinc-600">Citations only • No speculation</div>
        </div>
      </div>

      <nav className="flex items-center gap-2">
        <a href="#" className="hidden rounded-2xl px-3 py-2 text-sm text-zinc-700 hover:bg-white/70 hover:text-zinc-900 sm:inline">
          Library
        </a>
        <a href="#" className="rounded-2xl px-3 py-2 text-sm text-zinc-700 hover:bg-white/70 hover:text-zinc-900">
          About
        </a>
      </nav>
    </header>
  );
}

function Suggestion({ text, onPick }: { text: string; onPick: (t: string) => void }) {
  return (
    <button
      onClick={() => onPick(text)}
      className="group flex w-full items-center justify-between gap-3 rounded-2xl bg-white/70 px-4 py-3 text-left text-sm text-zinc-700 ring-1 ring-black/5 backdrop-blur transition hover:bg-white hover:text-zinc-900 hover:shadow-sm"
    >
      <span className="line-clamp-1">{text}</span>
      <span className="text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100">Use</span>
    </button>
  );
}

/** BIG SUMMARY ABOVE CITATIONS (extractive, not generated) */
function SummarySection({
  query,
  loading,
  results,
  onJumpToCitations,
}: {
  query: string;
  loading: boolean;
  results: SearchHit[];
  onJumpToCitations: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const items = useMemo(() => {
    if (!query || loading || !results.length) return [];
    return results.slice(0, 12).map((r, i) => ({
      n: i + 1,
      ref: r.ref,
      text: clip(r.snippet, 260),
    }));
  }, [query, loading, results]);

  const showEmpty = !!query && !loading && results.length === 0;
  const showSummary = !!query && !loading && results.length > 0;
  const long = items.length >= 8;

  return (
    <section id="summary" className="mt-6 rounded-[2rem] bg-white/70 p-6 shadow-sm ring-1 ring-black/5 backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Summary</div>
          <div className="mt-1 text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl">
            {query ? `Citations found for: “${query}”` : ""}
          </div>
          <div className="mt-2 text-sm text-zinc-600">
            Extractive only — short excerpts from the citations below. Nothing is invented.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onJumpToCitations}
            className="rounded-2xl bg-zinc-900 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-zinc-800"
          >
            Jump to citations ↓
          </button>
        </div>
      </div>

      {loading ? (
        <div className="mt-5 space-y-3">
          <div className="h-4 w-3/5 rounded bg-zinc-200/60" />
          <div className="h-4 w-11/12 rounded bg-zinc-200/50" />
          <div className="h-4 w-10/12 rounded bg-zinc-200/40" />
          <div className="h-4 w-9/12 rounded bg-zinc-200/30" />
        </div>
      ) : showEmpty ? (
        <div className="mt-5 rounded-3xl bg-zinc-50/80 p-5 ring-1 ring-black/5">
          <div className="text-base font-semibold text-zinc-900">No direct citation found.</div>
          <div className="mt-2 text-sm text-zinc-600">
            Try key terms or a reference (e.g., “BG 2.13”). The site must never invent an answer.
          </div>
        </div>
      ) : showSummary ? (
        <div className="mt-5 rounded-3xl bg-gradient-to-br from-amber-50/70 via-white to-indigo-50/50 p-5 ring-1 ring-black/5">
          <div className={cn("relative", !expanded && long && "max-h-[18rem] overflow-hidden")}>
            <ol className="space-y-4 text-lg leading-relaxed text-zinc-800 sm:text-xl">
              {items.map((it) => (
                <li key={it.n}>
                  <span className="font-semibold text-zinc-900">{it.n}. {it.ref}</span>
                  <span className="text-zinc-700"> — {it.text}</span>
                </li>
              ))}
            </ol>

            {!expanded && long && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white via-white/80 to-transparent" />
            )}
          </div>

          {long && (
            <div className="mt-4 flex items-center justify-end">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="rounded-2xl bg-white px-4 py-2 text-sm font-medium text-zinc-900 ring-1 ring-black/10 hover:bg-zinc-50"
              >
                {expanded ? "Show less" : "More"}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ResultCard({
  hit,
  selected,
  onSelect,
}: {
  hit: SearchHit;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full rounded-3xl p-5 text-left transition",
        "ring-1 ring-inset",
        selected ? "bg-white shadow-sm ring-zinc-900/20" : "bg-white/70 ring-black/5 hover:bg-white hover:shadow-sm",
        "backdrop-blur"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-zinc-900">{hit.ref}</div>
          <div className="mt-0.5 text-xs text-zinc-600">
            {hit.work}{hit.section ? ` • ${hit.section}` : ""}
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[11px] ring-1 ring-inset",
            hit.type === "purport" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-indigo-50 text-indigo-800 ring-indigo-200"
          )}
        >
          {hit.type}
        </span>
      </div>
      <div className="mt-3 text-sm leading-relaxed text-zinc-700">
        {clip(hit.snippet, 320)}
      </div>
    </button>
  );
}

function PassageViewer({ hit }: { hit: SearchHit | null }) {
  const copy = async () => {
    if (!hit) return;
    const text = `${hit.snippet}\n\n— ${hit.ref} (${hit.work}${hit.section ? `, ${hit.section}` : ""})`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  if (!hit) {
    return (
      <div className="rounded-3xl bg-white/70 p-6 shadow-sm ring-1 ring-black/5 backdrop-blur">
        <div className="text-sm font-semibold text-zinc-900">Passage</div>
        <div className="mt-2 text-sm text-zinc-600">Select a citation to view it here.</div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl bg-white/70 p-6 shadow-sm ring-1 ring-black/5 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-900">{hit.ref}</div>
          <div className="mt-1 text-xs text-zinc-600">
            {hit.work}{hit.section ? ` • ${hit.section}` : ""}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={copy} className="rounded-2xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white shadow-sm hover:bg-zinc-800">
            Copy
          </button>
          <a href={hit.url || "#"} className="rounded-2xl bg-white px-3 py-2 text-xs font-medium text-zinc-900 ring-1 ring-black/10 hover:bg-zinc-50">
            Open
          </a>
        </div>
      </div>

      <div className="mt-5 rounded-3xl bg-gradient-to-br from-amber-50/70 via-white to-indigo-50/50 p-5 ring-1 ring-black/5">
        <div className="text-sm leading-relaxed text-zinc-800 whitespace-pre-wrap">{hit.snippet}</div>
      </div>
    </div>
  );
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [loading, setLoading] = useState(false);

  const [results, setResults] = useState<SearchHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useHotkey("k", () => inputRef.current?.focus());

  const selected = useMemo(() => results.find((r) => r.id === selectedId) || null, [results, selectedId]);

  const suggestions = [
    "How can I chant attentively?",
    "What does surrender mean in bhakti?",
    "How to overcome laziness in spiritual life?",
  ];

  async function run(q: string) {
    const clean = q.trim();
    setSubmitted(clean);
    if (!clean) return;

    setLoading(true);
    setResults([]);
    setSelectedId(null);

    try {
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: clean, k: 8 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Search failed");

      const rows: Row[] = data.rows || [];
      const hits: SearchHit[] = [];

      for (const row of rows) {
        const label = row.verse_label || String(row.verse);
        const ref = `BG ${row.chapter}.${label}`;
        const url = vedabaseUrl(row.chapter, row.verse_label, row.verse);

        if (row.translation) {
          hits.push({
            id: `t-${row.chapter}-${label}`,
            ref,
            work: row.work,
            section: "Translation",
            type: "scripture",
            snippet: row.translation,
            url,
          });
        }
        if (row.purport) {
          hits.push({
            id: `p-${row.chapter}-${label}`,
            ref,
            work: row.work,
            section: "Purport",
            type: "purport",
            snippet: row.purport,
            url,
          });
        }
      }

      setResults(hits);
      setSelectedId(hits[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }

  const isLanding = !submitted;

  return (
    // IMPORTANT: your layout.tsx uses overflow-hidden. So THIS page must manage its own scroll.
    <div className="relative h-full overflow-y-auto bg-gradient-to-b from-amber-50 via-white to-indigo-50 text-zinc-900">
      <SoftBackground />
      <TopBar />

      {isLanding ? (
        <main className="mx-auto flex max-w-3xl flex-col items-center px-4 pb-16 pt-10 sm:pt-20">
          <div className="text-center">
            <div className="text-sm text-zinc-600">Hare Kṛṣṇa</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-5xl">
              Ask through Śrīla Prabhupāda’s books.
            </h1>
            <p className="mt-4 max-w-2xl text-sm text-zinc-600">
              This site returns <span className="font-medium text-zinc-800">direct citations</span> — not generated opinions.
            </p>
          </div>

          <div className="mt-8 w-full">
            <div className="rounded-[1.75rem] bg-white/80 p-3 shadow-sm ring-1 ring-black/10 backdrop-blur">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Your question</label>
                    <span className="text-xs text-zinc-500">Ctrl/⌘ K</span>
                  </div>
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") run(query); }}
                    placeholder="e.g., How can I develop steady bhakti?"
                    className="mt-2 w-full rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-900 outline-none ring-1 ring-black/5 focus:bg-white focus:ring-zinc-900/20"
                  />
                </div>

                <button
                  onClick={() => run(query)}
                  className="rounded-2xl bg-zinc-900 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-zinc-800"
                >
                  Search
                </button>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Promise: If nothing is found, it will say “No direct citation found.”
              </div>
            </div>

            <div className="mt-6 grid w-full gap-2">
              {suggestions.map((s) => (
                <Suggestion key={s} text={s} onPick={(t) => { setQuery(t); run(t); }} />
              ))}
            </div>
          </div>

          <footer className="mt-12 text-center text-xs text-zinc-500">
            Built for service • Not a replacement for guru, sādhu, and śāstra
          </footer>
        </main>
      ) : (
        <main className="mx-auto max-w-6xl px-4 pb-16 pt-4">
          <div className="rounded-3xl bg-white/70 p-4 ring-1 ring-black/5 backdrop-blur">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Your question</label>
                  <button
                    onClick={() => { setSubmitted(""); setResults([]); setSelectedId(null); }}
                    className="text-xs text-zinc-600 hover:text-zinc-900"
                  >
                    New search
                  </button>
                </div>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") run(query); }}
                  className="mt-2 w-full rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-900 outline-none ring-1 ring-black/5 focus:bg-white focus:ring-zinc-900/20"
                />
              </div>
              <button
                onClick={() => run(query)}
                className="rounded-2xl bg-zinc-900 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-zinc-800"
              >
                Search
              </button>
            </div>
            <div className="mt-3 text-xs text-zinc-600">{loading ? "Searching…" : `${results.length} citation(s)`}</div>
          </div>

          {/* BIG SUMMARY ABOVE CITATIONS */}
          <SummarySection
            query={submitted}
            loading={loading}
            results={results}
            onJumpToCitations={() => {
              document.getElementById("citations")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />

          <div id="citations" className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
            <div className="space-y-4">
              {loading ? (
                <div className="rounded-3xl bg-white/70 p-6 ring-1 ring-black/5 backdrop-blur">
                  <div className="h-4 w-2/5 rounded bg-zinc-200/60" />
                  <div className="mt-3 h-4 w-11/12 rounded bg-zinc-200/40" />
                  <div className="mt-2 h-4 w-10/12 rounded bg-zinc-200/30" />
                </div>
              ) : results.length === 0 ? (
                <div className="rounded-3xl bg-white/70 p-6 shadow-sm ring-1 ring-black/5 backdrop-blur">
                  <div className="text-sm font-semibold text-zinc-900">No direct citation found.</div>
                  <div className="mt-2 text-sm text-zinc-600">
                    Try simpler wording or a reference like “BG 2.13”.
                  </div>
                </div>
              ) : (
                results.map((hit) => (
                  <ResultCard
                    key={hit.id}
                    hit={hit}
                    selected={hit.id === selectedId}
                    onSelect={() => setSelectedId(hit.id)}
                  />
                ))
              )}
            </div>

            <div className="space-y-6">
              <PassageViewer hit={selected} />
              <div className="rounded-3xl bg-white/70 p-5 shadow-sm ring-1 ring-black/5 backdrop-blur">
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Rule</div>
                <div className="mt-2 text-sm text-zinc-700">Keep the UI quiet. Let the śāstra speak.</div>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
