type Update = { date: string; title: string; details: string[] };

const UPDATES: Update[] = [
  {
    date: "2025-08-31",
    title: "Search wired to Supabase (text mode); UI polish",
    details: [
      "Home chat connected to Supabase RPC (no OpenAI needed for basic text search).",
      "Visual tweaks for clarity and warmth.",
    ],
  },
  {
    date: "2025-08-30",
    title: "Bhagavad-gītā fully imported",
    details: [
      "Verified verse coverage (700 verses) including range verse labels.",
      "Manual insert for BG 13.6–7 to preserve the combined purport.",
    ],
  },
  {
    date: "2025-08-29",
    title: "Supabase schema + RPCs",
    details: [
      "Created passages table and helper functions.",
      "Added robust JSON ingest with GitHub Actions.",
    ],
  },
  {
    date: "2025-08-28",
    title: "Project bootstrap",
    details: [
      "Next.js app scaffolded and deployed on Vercel.",
      "Initial design and navigation created.",
    ],
  },
];

export default function UpdatesPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <h1 className="text-3xl font-bold tracking-tight">Updates</h1>
      <p className="mt-2 text-gray-700">Latest first. A simple log so everyone can see the progress.</p>

      <ol className="mt-8 relative border-l border-black/10">
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

      <div className="mt-10 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <h3 className="text-xl font-semibold">What’s next</h3>
        <ul className="mt-2 list-disc pl-5 text-gray-800 space-y-1">
          <li>Integrate OpenAI embeddings for semantic search (needs API funds).</li>
          <li>Add Śrīmad-Bhāgavatam and Caitanya-caritāmṛta.</li>
          <li>Cross-references to Prabhupāda-līlāmṛta and selected ācārya commentaries.</li>
        </ul>
        <p className="mt-3 text-gray-700">
          <span className="font-semibold">Status:</span> Bhagavad-gītā is ready. We’re currently raising donations to enable
          OpenAI features for deeper semantic search.
        </p>
      </div>
    </div>
  );
}
