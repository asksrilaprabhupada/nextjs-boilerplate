/**
 * 04-steps-section.tsx — Steps Section
 *
 * Explains the three-step process: ask a question, AI searches the books, get a narrative answer.
 * Used on the /how-it-works page to guide new users.
 */
"use client";

import { useEffect, useRef } from "react";

const steps = [
  { number: "01", title: "Ask", description: "Type any spiritual, philosophical, or practical question. AI understands your intent and searches across 244,000 passages from books, lectures, and letters." },
  { number: "02", title: "Verify", description: "Read an answer built from Prabhupāda's actual words — every verse and purport citation links directly to Vedabase.io." },
  { number: "03", title: "Go deeper", description: "Open the original verse, read the full purport, and continue your study with related references across scriptures." },
];

export default function StepsSection() {
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
    <section ref={ref} style={{ padding: "80px clamp(20px,5vw,80px)", maxWidth: 1200, margin: "0 auto", background: "linear-gradient(145deg, color-mix(in srgb, var(--surface-raised) 60%, transparent), color-mix(in srgb, var(--accent-tint) 55%, transparent) 56%, color-mix(in srgb, var(--p-gold) 46%, transparent))", borderRadius: 28, border: "1px solid color-mix(in srgb, var(--surface-raised) 62%, transparent)", boxShadow: "0 18px 44px color-mix(in srgb, var(--ink) 10%, transparent)" }}>
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 48 }}>
        <p className="section-label">How It Works</p>
        <h2 className="font-display" style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: "-0.02em", color: "var(--ink)" }}>
          Three steps to <span className="gradient-text">spiritual clarity</span>
        </h2>
      </div>

      <div className="steps-grid scroll-reveal" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, maxWidth: 900, margin: "0 auto" }}>
        {steps.map((step, i) => (
          <div key={step.number} style={{ textAlign: "center", position: "relative", padding: "0 20px" }}>
            <div className="font-display" style={{ fontSize: 48, fontWeight: 600, lineHeight: 1, color: "var(--accent-tint)", marginBottom: 16 }}>
              {step.number}
            </div>

            {/* Dot + line connector */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 20, marginBottom: 16 }}>
              {i > 0 ? <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, color-mix(in srgb, var(--accent-tint) 15%, transparent), color-mix(in srgb, var(--accent-tint) 40%, transparent))" }} /> : <div style={{ flex: 1 }} />}
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent-tint)", flexShrink: 0, boxShadow: "0 0 8px color-mix(in srgb, var(--accent-tint) 40%, transparent)" }} />
              {i < steps.length - 1 ? <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, color-mix(in srgb, var(--accent-tint) 40%, transparent), color-mix(in srgb, var(--accent-tint) 15%, transparent))" }} /> : <div style={{ flex: 1 }} />}
            </div>

            <h3 className="font-body" style={{ fontSize: 19, fontWeight: 600, color: "var(--ink)", marginBottom: 10 }}>{step.title}</h3>
            <p className="font-body" style={{ fontSize: 14, fontWeight: 400, lineHeight: 1.7, color: "var(--ink)", maxWidth: 260, margin: "0 auto" }}>{step.description}</p>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 768px) {
          .steps-grid { grid-template-columns: 1fr !important; gap: 24px !important; max-width: 400px !important; }
        }
      `}</style>
    </section>
  );
}