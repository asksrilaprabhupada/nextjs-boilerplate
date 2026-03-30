/**
 * 05-cta-section.tsx — Call-to-Action Section
 *
 * Renders a prominent call-to-action encouraging visitors to try searching.
 * Drives user engagement by prompting them to ask their first question.
 */
"use client";

import { useEffect, useRef } from "react";

export default function CTASection() {
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
    <section ref={ref} style={{ padding: "60px clamp(20px, 5vw, 80px)", maxWidth: 800, margin: "0 auto" }}>
      <div className="scroll-reveal" style={{
        textAlign: "center", padding: "clamp(28px, 6vw, 48px) clamp(20px, 5vw, 40px)",
        borderRadius: 24,
        background: "linear-gradient(135deg, rgba(245,240,255,0.6) 0%, rgba(251,207,232,0.15) 50%, rgba(253,230,138,0.08) 100%)",
        border: "1px solid rgba(196,181,253,0.2)",
        position: "relative", overflow: "hidden",
      }}>
        {/* Subtle glow */}
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 400, height: 250, borderRadius: "50%", background: "radial-gradient(circle, rgba(196,181,253,0.12) 0%, transparent 70%)", filter: "blur(40px)", pointerEvents: "none" }} />

        <div style={{ position: "relative", zIndex: 1 }}>
          <h2 className="font-display" style={{ fontSize: "clamp(26px, 3.5vw, 40px)", fontWeight: 600, lineHeight: 1.2, letterSpacing: "-0.02em", color: "#1E1B4B", marginBottom: 12 }}>
            Ask your first question
          </h2>
          <p className="font-body" style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7, color: "#374151", marginBottom: 28, maxWidth: 480, margin: "0 auto 28px" }}>
            36 books. 3,700 lectures. 6,500 letters. Every answer grounded in Śrīla Prabhupāda&apos;s actual words.
          </p>
          <button className="btn-primary" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
            <span>Search the books</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ position: "relative", zIndex: 1 }}><path d="M5 12h14M12 5l7 7-7 7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </section>
  );
}