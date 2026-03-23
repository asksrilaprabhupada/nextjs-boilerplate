"use client";

import { useEffect, useRef } from "react";

export default function CTASection() {
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
        padding: "120px clamp(20px, 5vw, 80px)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Large blurred glow */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 700,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(139,92,246,0.15) 0%, rgba(217,70,239,0.08) 50%, transparent 80%)",
          filter: "blur(40px)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          maxWidth: 640,
          margin: "0 auto",
        }}
      >
        <p className="section-label scroll-reveal">Get Started</p>
        <h2
          className="font-display scroll-reveal"
          style={{
            fontSize: "clamp(32px, 4vw, 52px)",
            fontWeight: 400,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            color: "var(--text-primary)",
            marginBottom: 20,
          }}
        >
          Begin your journey through <span className="gradient-text">divine wisdom</span>
        </h2>
        <p
          className="font-body scroll-reveal"
          style={{
            fontSize: 17,
            fontWeight: 300,
            lineHeight: 1.7,
            color: "var(--text-secondary)",
            marginBottom: 36,
          }}
        >
          25,020 verses from Bhagavad Gītā, Śrīmad Bhāgavatam, and Caitanya Caritāmṛta — all at your fingertips.
        </p>
        <div className="scroll-reveal" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            className="btn-primary"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <span>Start Exploring</span>
          </button>
          <a
            href="https://github.com/asksrilaprabhupada/nextjs-boilerplate"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost"
          >
            View Source Code
          </a>
        </div>
      </div>
    </section>
  );
}
