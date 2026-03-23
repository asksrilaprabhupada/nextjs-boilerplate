"use client";

import { useEffect, useRef } from "react";

const testimonials = [
  {
    quote: "This tool transformed my morning study. I can explore any question and find the exact verse Prabhupāda references.",
    name: "Radha Govinda Das",
    role: "Temple President",
    color: "var(--aurora-violet)",
  },
  {
    quote: "Having all three scriptures searchable from one place is invaluable. The layered exploration is brilliantly designed.",
    name: "Vrindavan Lila Devi",
    role: "Bhakti Scholar",
    color: "var(--aurora-teal)",
  },
  {
    quote: "As a new devotee, this helped me find answers to my deepest questions — all grounded in Prabhupāda's actual words.",
    name: "Arjuna Krishna Das",
    role: "Aspiring Devotee",
    color: "var(--aurora-fuchsia)",
  },
];

export default function TestimonialsSection() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".scroll-reveal").forEach((child, i) => {
              setTimeout(() => child.classList.add("visible"), i * 80);
            });
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
    <section
      ref={ref}
      style={{
        padding: "100px clamp(20px, 5vw, 80px)",
        maxWidth: 1200,
        margin: "0 auto",
      }}
    >
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 60 }}>
        <p className="section-label">Testimonials</p>
        <h2
          className="font-display"
          style={{
            fontSize: "clamp(32px, 4vw, 52px)",
            fontWeight: 400,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            color: "var(--text-primary)",
          }}
        >
          Loved by <span className="gradient-text">devotees worldwide</span>
        </h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 20,
        }}
      >
        {testimonials.map((t) => (
          <div
            key={t.name}
            className="aurora-card scroll-reveal"
            style={{ display: "flex", flexDirection: "column", gap: 24 }}
          >
            <p
              className="font-body"
              style={{
                fontSize: 16,
                fontWeight: 300,
                fontStyle: "italic",
                lineHeight: 1.7,
                color: "var(--text-secondary)",
                flex: 1,
              }}
            >
              &ldquo;{t.quote}&rdquo;
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: `color-mix(in srgb, ${t.color} 15%, transparent)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: t.color,
                  fontSize: 18,
                  fontWeight: 500,
                }}
                className="font-display"
              >
                {t.name[0]}
              </div>
              <div>
                <div
                  className="font-body"
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "var(--text-primary)",
                  }}
                >
                  {t.name}
                </div>
                <div
                  className="font-body"
                  style={{
                    fontSize: 13,
                    fontWeight: 400,
                    color: "var(--text-muted)",
                  }}
                >
                  {t.role}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 900px) {
          div[style*="grid-template-columns: repeat(3"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </section>
  );
}
