// app/updates/page.tsx

type Update = { date: string; title: string; details: string[] };

const WHATS_NEXT: string[] = [
  "Open donations to fund advanced features.",
  "Add Śrīmad-Bhāgavatam, then Caitanya-caritāmṛta.",
  "Add cross-references with Prabhupāda-līlāmṛta and other commentaries.",
];

const UPDATES: Update[] = [
  {
    date: "2025-09-01",
    title: "New pages + messages and feature requests",
    details: [
      "Added two pages: Request a Feature and Contact.",
      "Feature requests go to our Google Sheet; you also get a copy by email.",
      "Made the site more stable and easier to update.",
    ],
  },
  {
    date: "2025-08-31",
    title: "Better experience on phones",
    details: [
      "On phones: new welcome screen—tap to start.",
      "Phones show a clean chat view; computers keep two columns.",
      "Text and colors are easier to read.",
    ],
  },
  {
    date: "2025-08-31",
    title: "Search connected to scripture",
    details: [
      "You can ask by verse (like “BG 15.1”) or by a keyword.",
      "We show the verse and translation; you can open the purport.",
      "Results are clearer to read.",
    ],
  },
  {
    date: "2025-08-30",
    title: "Bhagavad-gītā fully loaded",
    details: [
      "All 700 verses are in the app.",
      "The special case 13.6–7 is stored correctly.",
      "We checked each chapter for gaps.",
    ],
  },
  {
    date: "2025-08-30",
    title: "Database prepared",
    details: [
      "Set up the database for verses.",
      "Imports are safe to run again if needed.",
      "Search is set up and ready.",
    ],
  },
  {
    date: "2025-08-29",
    title: "Project cleanup",
    details: [
      "Cleaned up project files.",
      "Fixed problems when pushing code.",
      "Added a simple script to import verses.",
    ],
  },
  {
    date: "2025-08-28",
    title: "Project started",
    details: [
      "Launched the website.",
      "Added the main menu and pages.",
    ],
  },
];

export default function UpdatesPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-bold tracking-tight">Updates</h1>
        <p className="mt-2 text-gray-700">Short, simple notes on what changed.</p>

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
            add more books and features.
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
