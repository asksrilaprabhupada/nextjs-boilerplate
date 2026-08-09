/**
 * 05-testimonials-section.tsx — Testimonials Section
 *
 * Displays user testimonials and quotes about the platform.
 * Builds trust and credibility with new visitors on the landing page.
 */
"use client";

import { useEffect, useRef } from "react";

// TODO(owner): replace with real quotes — these are labelled placeholders
// ([FAKE] prefix). This component is currently unmounted; the live carousel
// lives in cinematic/01-cinematic-home.tsx with the same placeholder set.
const testimonials = [
  {
    quote: "[FAKE] I use it every morning to trace a topic across Gītā, Bhāgavatam, and purports in under 5 minutes. It has completely transformed how I prepare for class.",
    name: "XXX",
    role: "Temple President · ISKCON AAA",
    color: "var(--accent)",
  },
  {
    quote: "[FAKE] It helps me prepare Bhāgavatam classes faster because I can verify the exact source immediately — no more flipping through six books to find one purport.",
    name: "BBB",
    role: "Bhakti-śāstrī Scholar",
    color: "var(--accent)",
  },
  {
    quote: "[FAKE] As a new devotee, it helped me study without relying on unsourced summaries. Every answer links back to Prabhupāda's actual words, so I know it's authentic.",
    name: "CCC",
    role: "Aspiring Devotee · 6 months",
    color: "var(--accent)",
  },
];

export default function TestimonialsSection() {
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
    <section ref={ref} style={{ padding: "80px clamp(20px, 5vw, 80px)", maxWidth: 1200, margin: "0 auto" }}>
      <div className="scroll-reveal" style={{ textAlign: "center", marginBottom: 40 }}>
        <p className="section-label">Testimonials</p>
        <h2 className="font-display" style={{ fontSize: "clamp(28px, 3.5vw, 44px)", fontWeight: 600, lineHeight: 1.15, letterSpacing: "-0.02em", color: "var(--ink)" }}>
          Trusted by <span className="gradient-text">devotees worldwide</span>
        </h2>
      </div>

      <div className="testimonials-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {testimonials.map((t) => (
          <div key={t.name} className="aurora-card scroll-reveal" style={{ display: "flex", flexDirection: "column", gap: 20, padding: "28px 24px" }}>
            <div className="font-display" style={{ fontSize: 40, lineHeight: 1, color: "color-mix(in srgb, var(--accent-tint) 40%, transparent)", fontWeight: 600 }}>&ldquo;</div>
            <p className="font-body" style={{ fontSize: 15, fontWeight: 400, fontStyle: "italic", lineHeight: 1.7, color: "var(--ink)", flex: 1, marginTop: -12 }}>
              {t.quote}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid color-mix(in srgb, var(--accent-tint) 15%, transparent)", paddingTop: 16 }}>
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: "color-mix(in srgb, var(--accent) 8%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", color: t.color, fontSize: 16, fontWeight: 600 }} className="font-display">
                {t.name[0]}
              </div>
              <div>
                <div className="font-body" style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{t.name}</div>
                <div className="font-body" style={{ fontSize: 12, fontWeight: 400, color: "var(--ink-muted)" }}>{t.role}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <style jsx>{`
        @media (max-width: 1024px) {
          .testimonials-grid { grid-template-columns: 1fr 1fr !important; }
        }
        @media (max-width: 640px) {
          .testimonials-grid { grid-template-columns: 1fr !important; gap: 14px !important; }
        }
      `}</style>
    </section>
  );
}