export default function InspirationPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-14 space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Inspiration</h1>

        <p className="text-gray-800">
          This project is a humble offering at the feet of His Divine Grace A. C. Bhaktivedanta
          Swami Prabhupāda. The goal is simple: enable deep, accurate study of Vaiṣṇava
          literatures—Bhagavad-gītā As It Is, Śrīmad-Bhāgavatam, Caitanya-caritāmṛta, and the writings
          of our ācāryas—so that seekers can quickly find, compare, and meditate on authentic teachings.
        </p>

        <p className="text-gray-800">
          Example: if you’re reflecting on <span className="font-medium">Bhagavad-gītā 15.1</span>,
          you can search for “field of activities”, “false ego”, “three modes”, or related terms and see
          relevant translations and purport extracts in one place. As the library grows, we’ll include
          cross-references from Prabhupāda-līlāmṛta, our ācāryas’ commentaries, and more.
        </p>

        <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">Why now?</h2>
          <p className="mt-2 text-gray-700">
            Students often navigate scattered sources. Bringing everything together—with careful grounding
            and citations—helps study become both faithful and efficient.
          </p>
        </div>
      </div>
    </div>
  );
}
