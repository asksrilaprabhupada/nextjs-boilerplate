"use client";

export default function AboutOverlay() {
  return (
    <div>
      <h2
        className="font-cormorant"
        style={{
          fontSize: "1.6rem",
          fontWeight: 500,
          color: "var(--text-primary)",
          marginBottom: 20,
        }}
      >
        About Ask Śrīla Prabhupāda
      </h2>
      <div
        className="font-cormorant"
        style={{
          fontSize: "1rem",
          lineHeight: 1.8,
          color: "var(--text-secondary)",
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
          Our database contains <strong style={{ color: "var(--saffron)" }}>25,020 verses</strong> across
          415 chapters, each with original Sanskrit/Bengali, transliteration, word-for-word synonyms,
          translation, and the complete purport by Śrīla Prabhupāda.
        </p>
        <p
          style={{
            fontSize: "0.9rem",
            color: "var(--text-muted)",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 16,
            marginTop: 8,
          }}
        >
          Open source on GitHub. Created and maintained by devotees.
        </p>
      </div>
    </div>
  );
}
