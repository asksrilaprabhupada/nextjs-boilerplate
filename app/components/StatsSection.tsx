"use client";

import { useEffect, useRef } from "react";

const stats = [
  { value: "25,020", label: "Verses Indexed", color: "var(--aurora-violet)" },
  { value: "3", label: "Scriptures", color: "var(--aurora-teal)" },
  { value: "100%", label: "Open Source", color: "var(--aurora-fuchsia)" },
  { value: "∞", label: "Queries Per Day", color: "var(--aurora-cyan)" },
];

export default function StatsSection() {
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
        padding: "0 clamp(20px, 5vw, 80px)",
        maxWidth: 1200,
        margin: "0 auto 80px",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 1,
          background: "var(--border-subtle)",
          borderRadius: 20,
          overflow: "hidden",
        }}
      >
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="scroll-reveal"
            style={{
              background: "var(--bg-surface)",
              padding: "40px 24px",
              textAlign: "center",
            }}
          >
            <div
              className="font-display"
              style={{
                fontSize: "clamp(36px, 4vw, 48px)",
                fontWeight: 400,
                color: stat.color,
                lineHeight: 1.1,
                marginBottom: 8,
              }}
            >
              {stat.value}
            </div>
            <div
              className="font-body"
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 600px) {
          div[style*="grid-template-columns: repeat(4"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </section>
  );
}
