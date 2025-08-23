import Image from "next/image";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[#FFF7EA] to-[#EDE6FF] p-6">
      <div className="text-center max-w-2xl">
        <Image
          src="/prabhupada.jpg"
          alt="Śrīla Prabhupāda writing"
          width={480}
          height={480}
          className="rounded-2xl shadow-lg mx-auto mb-6 object-cover"
          priority
        />
        <h1 className="text-4xl font-bold mb-3 text-gray-900">
          Ask Śrīla Prabhupāda
        </h1>
        <p className="text-lg text-gray-700 mb-6">
          Answers grounded only in <em>Bhagavad-gītā As It Is</em>. <br />
          <strong>No speculation.</strong>
        </p>
        <div className="flex justify-center gap-3">
          <a className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg shadow">
            Get Started
          </a>
          <a className="border border-orange-500 text-orange-600 px-6 py-3 rounded-lg hover:bg-orange-50">
            Learn More
          </a>
        </div>
      </div>
    </main>
  );
}
