"use client";

import { useEffect, useRef } from "react";

const trustPoints = [
  { text: "27 books searchable", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg> },
  { text: "25,000+ verses indexed", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg> },
  { text: "Exact citations to sources", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg> },
  { text: "Complete purports included", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg> },
];

export default function TrustStrip() {
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
    <section ref={ref} style={{ padding: "0 clamp(20px, 5vw, 80px)", maxWidth: 1200, margin: "0 auto 40px" }}>
      <div className="scroll-reveal" style={{
        display: "flex", justifyContent: "center", flexWrap: "wrap",
        gap: "12px 36px", padding: "24px 32px",
        borderRadius: 16,
        background: "rgba(245,240,255,0.4)",
        border: "1px solid rgba(196,181,253,0.2)",
      }}>
        {trustPoints.map(tp => (
          <div key={tp.text} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {tp.icon}
            <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: "#374151" }}>{tp.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}