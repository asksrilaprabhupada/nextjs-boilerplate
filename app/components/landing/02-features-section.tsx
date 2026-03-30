/**
 * 02-features-section.tsx — Features Section
 *
 * Showcases the main features of the platform with icons and descriptions.
 * Used on both the home page and the dedicated /features page.
 */
"use client";

import { useEffect, useRef } from "react";

const features = [
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>,
    color: "#8B5CF6", bgTint: "rgba(139,92,246,0.10)",
    title: "AI-Powered Search",
    description: "Ask any question in natural language. AI extracts keywords and synonyms, then searches across 244,000+ passages from books, lectures, and letters.",
    span: false,
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg>,
    color: "#7C3AED", bgTint: "rgba(124,58,237,0.10)",
    title: "36 Books, Lectures & Letters",
    description: "Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, Kṛṣṇa Book, Teachings of Lord Caitanya, and 30 more books — plus 3,700 lectures and 6,500 letters — all searchable from one interface.",
    span: true,
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
    color: "#A855F7", bgTint: "rgba(168,85,247,0.10)",
    title: "Prabhupāda's Purports",
    description: "Access complete commentary and purports by His Divine Grace for every verse — with direct links to Vedabase.io for full context.",
    span: false,
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
    color: "#6366F1", bgTint: "rgba(99,102,241,0.10)",
    title: "Narrative Answers",
    description: "AI weaves Prabhupāda's actual words into flowing answers — \"Lord Kṛṣṇa says...\" for translations, \"Prabhupāda explains...\" for purports. Never AI-generated philosophy.",
    span: true,
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></svg>,
    color: "#8B5CF6", bgTint: "rgba(139,92,246,0.10)",
    title: "Citation Links",
    description: "Every verse reference links directly to Vedabase.io. Click any citation to read the full verse, synonyms, and complete purport.",
    span: false,
  },
  {
    icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /></svg>,
    color: "#6366F1", bgTint: "rgba(99,102,241,0.10)",
    title: "Open Source",
    description: "Built with Next.js, TypeScript, Supabase, and Claude AI. Fully open source — inspect, contribute, or self-host.",
    span: false,
  },
];

export default function FeaturesSection() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.querySelectorAll(".scroll-reveal").forEach((child, i) => setTimeout(() => child.classList.add("visible"), i * 80));
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={ref} style={{ padding: "clamp(48px, 8vw, 100px) clamp(16px,5vw,80px)", maxWidth: 1200, margin: "0 auto", background: "linear-gradient(145deg, rgba(255,255,255,0.62), rgba(246,238,255,0.56) 55%, rgba(255,245,235,0.5))", borderRadius: "clamp(18px, 3vw, 28px)", border: "1px solid rgba(255,255,255,0.65)", boxShadow: "0 18px 44px rgba(109,74,176,0.10)" }}>
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 60 }}>
        <p className="section-label">Features</p>
        <h2 className="font-display" style={{ fontSize: "clamp(32px,4vw,52px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: "-0.02em", color: "#1E1B4B" }}>
          Everything you need to <span className="gradient-text">explore scripture</span>
        </h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {features.map((f, i) => (
          <div key={f.title} className="aurora-card scroll-reveal" style={{ gridColumn: f.span ? "span 2" : "span 1", transitionDelay: `${i * 80}ms` }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: f.bgTint, display: "flex", alignItems: "center", justifyContent: "center", color: f.color, marginBottom: 20 }}>{f.icon}</div>
            <h3 className="font-body" style={{ fontSize: 19, fontWeight: 500, color: "#1E1B4B", marginBottom: 10 }}>{f.title}</h3>
            <p className="font-body" style={{ fontSize: 16, fontWeight: 400, lineHeight: 1.7, color: "#374151" }}>{f.description}</p>
          </div>
        ))}
      </div>
      <style jsx>{`
        @media (max-width: 900px) {
          div[style*="grid-template-columns"] { grid-template-columns: 1fr 1fr !important; }
          div[style*="span 2"] { grid-column: span 2 !important; }
        }
        @media (max-width: 640px) {
          div[style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
          div[style*="span 2"] { grid-column: span 1 !important; }
        }
      `}</style>
    </section>
  );
}