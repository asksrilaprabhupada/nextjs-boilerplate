"use client";

import { useEffect, useRef } from "react";

const testimonials = [
  {
    quote: "This tool transformed my morning study. I can explore any question and find the exact verse Prabhupāda references.",
    name: "Radha Govinda Das",
    role: "Temple President",
    color: "#8B5CF6",
  },
  {
    quote: "Having all three scriptures searchable from one place is invaluable. The layered exploration is brilliantly designed.",
    name: "Vrindavan Lila Devi",
    role: "Bhakti Scholar",
    color: "#7C3AED",
  },
  {
    quote: "As a new devotee, this helped me find answers to my deepest questions — all grounded in Prabhupāda's actual words.",
    name: "Arjuna Krishna Das",
    role: "Aspiring Devotee",
    color: "#6366F1",
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
            fontWeight: 600,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            color: "#1E1B4B",
          }}
        >
          Loved by <span className="gradient-text">devotees worldwide</span>
        </h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 24,
        }}
      >
        {testimonials.map((t) => (
          <div
            key={t.name}
            className="aurora-card scroll-reveal"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 28,
              padding: "36px 32px",
            }}
          >
            {/* Quote mark accent */}
            <div
              className="font-display"
              style={{
                fontSize: 48,
                lineHeight: 1,
                color: "rgba(196, 181, 253, 0.4)",
                fontWeight: 600,
                marginBottom: -16,
              }}
            >
              &ldquo;
            </div>
            <p
              className="font-body"
              style={{
                fontSize: 16,
                fontWeight: 400,
                fontStyle: "italic",
                lineHeight: 1.7,
                color: "#4B5563",
                flex: 1,
              }}
            >
              {t.quote}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: `rgba(139, 92, 246, 0.08)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: t.color,
                  fontSize: 18,
                  fontWeight: 600,
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
                    color: "#1E1B4B",
                  }}
                >
                  {t.name}
                </div>
                <div
                  className="font-body"
                  style={{
                    fontSize: 13,
                    fontWeight: 400,
                    color: "#9CA3AF",
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
