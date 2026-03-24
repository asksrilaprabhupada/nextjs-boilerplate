"use client";

import { useEffect, useRef } from "react";

const steps = [
  { number: "01", title: "Ask Your Question", description: "Type any spiritual question in natural language. AI understands your intent and extracts the right search terms automatically." },
  { number: "02", title: "Discover Scripture", description: "AI searches across 27 books — verses, purports, and prose — finding the most relevant passages from Prabhupāda's writings." },
  { number: "03", title: "Read the Answer", description: "Get a flowing narrative answer with Prabhupāda's actual words, direct citations, and links to Vedabase.io for full context." },
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
    <section ref={ref} style={{ padding: "100px clamp(20px,5vw,80px)", maxWidth: 1200, margin: "0 auto", background: "linear-gradient(145deg, rgba(255,255,255,0.6), rgba(246,238,255,0.55) 56%, rgba(255,245,235,0.46))", borderRadius: 28, border: "1px solid rgba(255,255,255,0.62)", boxShadow: "0 18px 44px rgba(109,74,176,0.10)" }}>
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 60 }}>
        <p className="section-label">How It Works</p>
        <h2 className="font-display" style={{ fontSize: "clamp(32px,4vw,52px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: "-0.02em", color: "#1E1B4B" }}>
          Three steps to <span className="gradient-text">spiritual clarity</span>
        </h2>
      </div>

      {/* Steps with dot connectors */}
      <div className="steps-grid scroll-reveal" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, maxWidth: 900, margin: "0 auto" }}>
        {steps.map((step, i) => (
          <div key={step.number} style={{ textAlign: "center", position: "relative", padding: "0 20px" }}>
            {/* Number */}
            <div className="font-display" style={{ fontSize: 56, fontWeight: 600, lineHeight: 1, color: "#9D7AF8", marginBottom: 20 }}>
              {step.number}
            </div>

            {/* Dot + line connector row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 20, marginBottom: 20 }}>
              {/* Line before dot (not on first step) */}
              {i > 0 && (
                <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(196,181,253,0.15), rgba(196,181,253,0.4))" }} />
              )}
              {i === 0 && <div style={{ flex: 1 }} />}

              {/* Dot */}
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#C4B5FD", flexShrink: 0, boxShadow: "0 0 8px rgba(196,181,253,0.4)" }} />

              {/* Line after dot (not on last step) */}
              {i < steps.length - 1 && (
                <div style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(196,181,253,0.4), rgba(196,181,253,0.15))" }} />
              )}
              {i === steps.length - 1 && <div style={{ flex: 1 }} />}
            </div>

            {/* Title */}
            <h3 className="font-body" style={{ fontSize: 19, fontWeight: 500, color: "#1E1B4B", marginBottom: 12 }}>
              {step.title}
            </h3>

            {/* Description */}
            <p className="font-body" style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7, color: "#4B5563", maxWidth: 280, margin: "0 auto" }}>
              {step.description}
            </p>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 900px) {
          .steps-grid {
            grid-template-columns: 1fr !important;
            gap: 40px !important;
          }
        }
      `}</style>
    </section>
  );
}