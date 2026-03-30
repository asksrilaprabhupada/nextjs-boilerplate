/**
 * 02-about-overlay.tsx — About Overlay
 *
 * Displays project information, mission statement, and statistics (25,131 verses, 36 books, lectures, letters).
 * Tells users about the purpose and scope of Ask Srila Prabhupada.
 */
"use client";

export default function AboutOverlay() {
  return (
    <div>
      <h2 className="font-display" style={{ fontSize: "1.6rem", fontWeight: 600, color: "#1E1B4B", marginBottom: 20, letterSpacing: "-0.02em" }}>
        About Ask Prabhupāda
      </h2>
      <div className="font-body" style={{ fontSize: 16, lineHeight: 1.7, fontWeight: 400, color: "#374151", display: "flex", flexDirection: "column", gap: 16 }}>
        <p>Ask Śrīla Prabhupāda is a devotional knowledge engine that helps devotees find scripture-grounded answers from the books, lectures, and letters of His Divine Grace A.C. Bhaktivedanta Swami Prabhupāda.</p>
        <p>Every answer is traced directly to specific verses and passages from Prabhupāda&apos;s teachings — Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, and 33 more books, plus 3,700 recorded lectures and 6,500 personal letters.</p>
        <p>The AI in this platform never teaches independently. It only introduces, contextualises, and provides transitions between Kṛṣṇa&apos;s words and Śrīla Prabhupāda&apos;s purports. Every philosophical statement comes directly from the scriptures.</p>
        <p>Our database contains <strong style={{ color: "#8B5CF6" }}>25,131 verses</strong>, <strong style={{ color: "#7C3AED" }}>36,412 prose paragraphs</strong>, <strong style={{ color: "#E8891C" }}>144,438 lecture passages</strong>, and <strong style={{ color: "#0F766E" }}>19,468 letter passages</strong> across <strong style={{ color: "#6366F1" }}>36 books, 3,703 lectures, and 6,587 letters</strong>. Every reference links directly to <a href="https://vedabase.io" target="_blank" rel="noopener noreferrer" style={{ color: "#8B5CF6", textDecoration: "none", fontWeight: 500 }}>Vedabase.io</a>.</p>
        <p style={{ fontSize: 14, color: "#6B7280", borderTop: "1px solid rgba(196,181,253,0.2)", paddingTop: 16, marginTop: 8 }}>
          Created and maintained by devotees. Powered by Gemini AI + Supabase.
        </p>
      </div>
    </div>
  );
}