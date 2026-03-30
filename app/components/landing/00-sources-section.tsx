/**
 * 00-sources-section.tsx — Sources Section
 *
 * Landing page section showcasing the breadth of Srila Prabhupada's library
 * that is searchable through the platform. Displays stats for books, lectures,
 * and letters in a three-card grid.
 */
"use client";

import { useEffect, useRef } from "react";

const sources = [
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
      </svg>
    ),
    stat: "36",
    label: "Books",
    description: "Bhagavad Gita, Srimad Bhagavatam, Caitanya Caritamrita, Nectar of Devotion, Krishna Book, and 30+ more titles.",
    color: "#8B5CF6",
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="23" />
        <line x1="8" x2="16" y1="23" y2="23" />
      </svg>
    ),
    stat: "3,700+",
    label: "Lectures",
    description: "Transcribed lectures, conversations, morning walks, and room conversations spanning decades of teaching.",
    color: "#7C3AED",
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect width="16" height="13" x="6" y="4" rx="2" />
        <path d="m22 7-7.1 3.78c-.57.3-1.23.3-1.8 0L6 7" />
        <path d="M2 8v11c0 1.1.9 2 2 2h2" />
      </svg>
    ),
    stat: "6,500+",
    label: "Letters",
    description: "Personal correspondence and instructions to disciples, friends, and world leaders.",
    color: "#6366F1",
  },
];

export default function SourcesSection() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".scroll-reveal").forEach((child, i) =>
              setTimeout(() => child.classList.add("visible"), i * 100)
            );
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={ref} style={{ padding: "60px clamp(20px, 5vw, 80px)", maxWidth: 1200, margin: "0 auto" }}>
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 40 }}>
        <p className="section-label">What you can search</p>
        <h2
          className="font-display"
          style={{
            fontSize: "clamp(28px, 3.5vw, 44px)",
            fontWeight: 600,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            color: "#1E1B4B",
          }}
        >
          <span className="gradient-text">Prabhupada&apos;s complete library</span>
        </h2>
      </div>

      <div
        className="sources-grid"
        style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}
      >
        {sources.map((source) => (
          <div key={source.label} className="aurora-card scroll-reveal" style={{ padding: "28px 24px", textAlign: "center" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "rgba(139,92,246,0.08)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: source.color,
                margin: "0 auto 16px",
              }}
            >
              {source.icon}
            </div>
            <p
              className="font-display"
              style={{
                fontSize: "clamp(32px, 4vw, 44px)",
                fontWeight: 700,
                letterSpacing: "-0.02em",
                color: source.color,
                lineHeight: 1.1,
                marginBottom: 4,
              }}
            >
              {source.stat}
            </p>
            <h3 className="font-body" style={{ fontSize: 18, fontWeight: 600, color: "#1E1B4B", marginBottom: 10 }}>
              {source.label}
            </h3>
            <p className="font-body" style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7, color: "#374151" }}>
              {source.description}
            </p>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 1024px) {
          .sources-grid { grid-template-columns: 1fr 1fr !important; }
        }
        @media (max-width: 640px) {
          .sources-grid { grid-template-columns: 1fr !important; gap: 14px !important; }
        }
      `}</style>
    </section>
  );
}
