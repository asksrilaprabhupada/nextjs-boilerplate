import Image from "next/image";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-[#FFF7EA] to-[#EDE6FF] p-6">
      <div className="text-center max-w-2xl">
        {/* Śrīla Prabhupāda’s Image */}
        <Image
          src="/prabhupada.jpg"
          alt="Śrīla Prabhupāda writing"
          width={400}   // adjust size as needed
          height={400}  // adjust size as needed
          className="rounded-2xl shadow-lg mx-auto mb-6"
          priority
        />

        {/* Title */}
        <h1 className="text-4xl font-bold mb-4 text-gray-900">
          Ask Śrīla Prabhupāda
        </h1>

        {/* Subtitle */}
        <p className="text-lg text-gray-700 mb-8">
          A place where devotees can ask questions and receive answers directly
          grounded in <em>Bhagavad-gītā As It Is</em>.
          <br />
          <strong>No speculation. Only scripture.</strong>
        </p>

        {/* Buttons */}
        <div className="flex justify-center gap-4">
          <a
            href="#"
            className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-3 rounded-lg shadow-lg"
          >
            Get Started
          </a>
          <a
            href="#"
            className="border border-orange-500 text-orange-600 px-6 py-3 rounded-lg hover:bg-orange-50"
          >
            Learn More
          </a>
        </div>
      </div>
    </main>
  );
}
