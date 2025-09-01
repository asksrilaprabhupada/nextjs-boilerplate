// app/updates/page.tsx

type Update = { date: string; title: string; details: string[] };

const WHATS_NEXT: string[] = [
  "Accept donations to enable OpenAI features in production (semantic search at scale).",
  "Ingest Śrīmad-Bhāgavatam; then Caitanya-caritāmṛta.",
  "Cross-references: Prabhupāda-līlāmṛta and ācārya commentaries.",
  "Verse permalinks and share buttons (e.g., /bg/15/1).",
  "Filters (chapter, topic tags) and better snippet highlighting.",
];

// ✅ Only the top three, most recent changes
const UPDATES: Update[] = [
  {
    date: "2025-08-31",
    title: "Mobile landing + chat-only flow; desktop preserved",
    details: [
      "New mobile welcome: full-screen photo with “Tap to enter”, then single-column chat.",
      "Desktop keeps two-column layout; gentle entrance + ‘breathing’ animation for the photo.",
      "Changed tagline to: “Answers come directly from Vaiṣṇava literatures.”",
    ],
  },
  {
    date: "2025-08-31",
    title: "Build fix + styles",
    details: [
      "Resolved Vercel/PostCSS issue; gradient moved to layout for reliability.",
      "Added small animation utilities in globals.css (float-in + breathe).",
    ],
  },
  {
    date: "2025-08-31",
    title: "Home chat wired to Supabase search",
    details: [
      "Server API route `/api/search` created.",
      "Calls Supabase RPC `search_passages_text` with direct verse fallback (e.g., 13.6–7).",
      "Results show verse-label ranges and expandable Purport.",
    ],
  },
];

export default function UpdatesPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-bold tracking-tight">Updates</h1>
        <p className="mt-2 text-gray-700">A living log of progress. Latest first.</p>

        {/* What's next — pinned at the top */}
        <div className="mt-8 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">What’s next</h2>
          <ul className="mt-3 list-disc pl-5 text-gray-800 space-y-1">
            {WHATS_NEXT.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
          <p className="mt-3 text-gray-700">
            <span className="font-semibold">Status:</span> Bhagavad-gītā is ready and searchable. Donations will help us
            enable OpenAI features in production and expand the library.
          </p>
        </div>

        {/* Timeline */}
        <ol className="mt-10 relative border-l border-black/10">
          {UPDATES.map((u, i) => (
            <li key={i} className="ml-6 pb-8 last:pb-0">
              <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full bg-orange-500 ring-2 ring-white" />
              <time className="text-xs uppercase tracking-wide text-gray-500">{u.date}</time>
              <h2 className="mt-1 text-lg font-semibold">{u.title}</h2>
              <ul className="mt-2 list-disc pl-5 text-gray-800 space-y-1">
                {u.details.map((d, j) => (
                  <li key={j}>{d}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
