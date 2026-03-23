"use client";

export default function AboutOverlay() {
  return (
    <div>
      <h2
        className="font-display"
        style={{
          fontSize: "1.6rem",
          fontWeight: 600,
          color: "#1E1B4B",
          marginBottom: 20,
          letterSpacing: "-0.02em",
        }}
      >
        About Ask Prabhupāda
      </h2>
      <div
        className="font-body"
        style={{
          fontSize: 16,
          lineHeight: 1.7,
          fontWeight: 400,
          color: "#4B5563",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <p>
          Ask Śrīla Prabhupāda is a devotional knowledge engine that helps devotees find
          scripture-grounded answers from the teachings of His Divine Grace A.C. Bhaktivedanta
          Swami Prabhupāda.
        </p>
        <p>
          Every answer is traced directly to specific verses from the Bhagavad Gītā As It Is,
          Śrīmad Bhāgavatam, and Śrī Caitanya Caritāmṛta — the three foundational scriptures
          of Gauḍīya Vaiṣṇavism.
        </p>
        <p>
          The AI in this platform never teaches independently. It only introduces, contextualizes,
          and provides transitions between Kṛṣṇa&apos;s words and Śrīla Prabhupāda&apos;s purports.
          Every philosophical statement comes directly from the scriptures.
        </p>
        <p>
          Our database contains <strong style={{ color: "#8B5CF6" }}>25,020 verses</strong> across
          415 chapters, each with original Sanskrit/Bengali, transliteration, word-for-word synonyms,
          translation, and the complete purport by Śrīla Prabhupāda.
        </p>
        <p
          style={{
            fontSize: 14,
            color: "#9CA3AF",
            borderTop: "1px solid rgba(196, 181, 253, 0.2)",
            paddingTop: 16,
            marginTop: 8,
          }}
        >
          Open source on{" "}
          <a
            href="https://github.com/asksrilaprabhupada/nextjs-boilerplate"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#8B5CF6", textDecoration: "none", fontWeight: 500 }}
          >
            GitHub
          </a>
          . Created and maintained by devotees.
        </p>
      </div>
    </div>
  );
}
