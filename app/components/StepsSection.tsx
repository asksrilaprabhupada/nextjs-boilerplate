"use client";

import { useEffect, useRef } from "react";

const steps = [
  {
    number: "01",
    title: "Ask Your Question",
    description: "Type any spiritual question or select from suggested topics. Our search understands natural language.",
  },
  {
    number: "02",
    title: "Discover Verses",
    description: "Receive relevant verses from across three scriptures, each traced to the exact chapter and verse number.",
  },
  {
    number: "03",
    title: "Go Deeper",
    description: "Explore the full purport and commentary by Śrīla Prabhupāda. Expand layer by layer for deeper understanding.",
  },
];

export default function StepsSection() {
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
        <p className="section-label">How It Works</p>
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
          Three steps to <span className="gradient-text">spiritual clarity</span>
        </h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 32,
          position: "relative",
        }}
      >
        {/* Connector lines (desktop only) */}
        <div
          className="step-connectors"
          style={{
            position: "absolute",
            top: 44,
            left: "18%",
            right: "18%",
            height: 2,
            background: "linear-gradient(90deg, var(--aurora-violet), var(--aurora-teal))",
            opacity: 0.4,
            zIndex: 0,
          }}
        />

        {steps.map((step, i) => (
          <div
            key={step.number}
            className="scroll-reveal"
            style={{
              textAlign: "center",
              position: "relative",
              zIndex: 1,
            }}
          >
            <div
              className="font-display"
              style={{
                fontSize: 64,
                fontWeight: 400,
                lineHeight: 1,
                marginBottom: 20,
                background: `linear-gradient(180deg, rgba(139,92,246,0.3) 0%, transparent 100%)`,
                backgroundClip: "text",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              {step.number}
            </div>
            <h3
              className="font-body"
              style={{
                fontSize: 19,
                fontWeight: 500,
                color: "var(--text-primary)",
                marginBottom: 12,
              }}
            >
              {step.title}
            </h3>
            <p
              className="font-body"
              style={{
                fontSize: 16,
                fontWeight: 300,
                lineHeight: 1.7,
                color: "var(--text-secondary)",
                maxWidth: 320,
                margin: "0 auto",
              }}
            >
              {step.description}
            </p>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 900px) {
          div[style*="grid-template-columns: repeat(3"] {
            grid-template-columns: 1fr !important;
          }
          .step-connectors {
            display: none !important;
          }
        }
      `}</style>
    </section>
  );
}
