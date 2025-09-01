// app/updates/page.tsx

type Update = { date: string; title: string; details: string[] };

const WHATS_NEXT: string[] = [
  "Accept donations to enable OpenAI features in production (semantic search at scale).",
  "Ingest Śrīmad-Bhāgavatam; then Caitanya-caritāmṛta.",
  "Cross-references: Prabhupāda-līlāmṛta and ācārya commentaries.",
];

const UPDATES: Update[] = [
  {
    date: "2025-09-01",
    title:
      "Request Feature & Contact tabs + Sheets logging + deploy/debug fixes",
    details: [
      "Added /request-feature and /contact; linked in TopNav (desktop & mobile).",
      "Feature saves to Google Sheets (sender gets a copy); Contact emails us privately.",
      "Stabilized deploys: classic build, fixed Google JWT for googleapis v159, added types and /api/_env & /api/_health.",
    ],
  },
  {
    date: "2025-08-31",
    title: "Mobile landing + chat-only flow; desktop preserved",
    details: [
      "Mobile welcome: full photo with “Tap to enter”, then single-column chat.",
      "Desktop keeps two-column layout with gentle entrance animation.",
      "Tagline updated: “Answers come directly from Vaiṣṇava literatures.”",
    ],
  },
  {
    date: "2025-08-31",
    title: "Build fix + styles",
    details: [
      "Resolved Vercel/PostCSS issue by removing body background override.",
      "Gradient moved into layout for reliability.",
      "Added small animation utilities in globals.css (float-in, breathe).",
    ],
  },
  {
    date: "2025-08-31",
    title: "Home chat wired to Supabase search",
    details: [
      "Server API `/api/search` with direct verse fallback (e.g., 13.6–7).",
      "Keyword search via RPC `search_passages_text`.",
      "Results show verse labels and expandable Purport.",
    ],
  },
  {
    date: "2025-08-30",
    title: "Bhagavad-gītā fully imported + verified",
    details: [
      "Cleaned JSON and ran import; verified coverage by chapter.",
      "Added BG 13.6–7 as a combined entry (one purport).",
      "All 700 verses present; ranges represented correctly.",
    ],
  },
  {
    date: "2025-08-30",
    title: "Supabase schema + RPCs",
    details: [
      "Created `passages` table (with verse_label support).",
      "RPC for idempotent upserts.",
      "Search RPC set up (text/vector ready).",
    ],
  },
  {
    date: "2025-08-29",
    title: "Repo hygiene + CI",
    details: [
      "Fixed `.gitignore` (ignore `node_modules/`).",
      "Learned/used `git pull --rebase` to avoid non-fast-forward errors.",
      "Added import script and GitHub Action to ingest JSON from `public/`.",
    ],
  },
  {
    date: "2025-08-28",
    title: "Project bootstrap",
    details: [
      "Next.js app scaffolded and deployed to Vercel.",
      "Top navigation (Home, Team, Inspiration, Updates).",
    ],
  },
];

export default function UpdatesPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-bold tracking-tight">Updates</h1>
        <p className="mt-2 text-gray-700">Short and simple notes on what changed.</p>

        {/* What's next — pinned at the top */}
        <div className="mt-8 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">What’s next</h2>
          <ul className="mt-3 list-disc pl-5 text-gray-800 space-y-1">
            {WHATS_NEXT.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
          <p className="mt-3 text-gray-700">
            <span className="font-semibold">Status:</span> Bhagavad-gītā is ready and searchable.
            Donations will help us enable advanced features and expand the library.
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
                {u.details.slice(0, 3).map((d, j) => (
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
