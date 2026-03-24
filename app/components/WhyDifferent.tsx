"use client";

import { useEffect, useRef } from "react";

const cards = [
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /></svg>,
    title: "Not AI fluff",
    description: "Answers are grounded in Śrīla Prabhupāda's original texts — translations and purports. The AI retrieves and connects. It never generates philosophy.",
    color: "#8B5CF6",
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>,
    title: "Exact citations",
    description: "Every reference links directly to Vedabase.io. Click any citation to read the full verse, synonyms, and complete purport in context.",
    color: "#7C3AED",
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg>,
    title: "One place for all major books",
    description: "Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, Kṛṣṇa Book, and 22 more — searched together, instantly.",
    color: "#6366F1",
  },
];

export default function WhyDifferent() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.querySelectorAll(".scroll-reveal").forEach((child, i) => setTimeout(() => child.classList.add("visible"), i * 100));
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={ref} style={{ padding: "60px clamp(20px, 5vw, 80px)", maxWidth: 1200, margin: "0 auto" }}>
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 40 }}>
        <p className="section-label">Why this is different</p>
        <h2 className="font-display" style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: "-0.02em", color: "#1E1B4B" }}>
          Grounded in <span className="gradient-text">Prabhupāda&apos;s actual words</span>
        </h2>
      </div>

      <div className="why-different-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {cards.map((card) => (
          <div key={card.title} className="aurora-card scroll-reveal" style={{ padding: "28px 24px" }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: `rgba(139,92,246,0.08)`, display: "flex", alignItems: "center", justifyContent: "center", color: card.color, marginBottom: 16 }}>
              {card.icon}
            </div>
            <h3 className="font-body" style={{ fontSize: 18, fontWeight: 600, color: "#1E1B4B", marginBottom: 8 }}>{card.title}</h3>
            <p className="font-body" style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7, color: "#4B5563" }}>{card.description}</p>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 768px) {
          .why-different-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  );
}