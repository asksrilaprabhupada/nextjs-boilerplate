"use client";

import { useState } from "react";

type Row = {
  work: string;
  chapter: number;
  verse: number;
  translation: string | null;
  sanskrit: string | null;
  transliteration: string | null;
  synonyms: string | null;
  purport: string | null;
  distance: number;
};

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    setRows([]);
    try {
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, k: 5 })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Search failed");
      setRows(data.rows);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Bhagavad-gītā Search</h1>

      <form onSubmit={onSearch} className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask anything… e.g., duty and detachment"
          className="flex-1 border rounded px-3 py-2"
        />
        <button
          disabled={loading || !q.trim()}
          className="border rounded px-4 py-2 disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {err && <p className="text-red-600">{err}</p>}

      <ul className="space-y-4">
        {rows.map((r, i) => (
          <li key={i} className="border rounded p-4">
            <div className="text-sm text-gray-600">
              {r.work} {r.chapter}.{r.verse} · score {(1 - r.distance).toFixed(3)}
            </div>
            {r.translation && <p className="mt-2">{r.translation}</p>}
            {r.purport && (
              <details className="mt-2">
                <summary>PURPORT</summary>
                <p className="mt-1 whitespace-pre-wrap">{r.purport}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
