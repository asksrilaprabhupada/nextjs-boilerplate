/**
 * 05-search-progress.tsx — Search Progress Indicator
 *
 * Shows a multi-step progress bar during search with descriptive labels for each stage.
 * Keeps users informed while the AI processes their query.
 */
"use client";

import { useState, useEffect } from "react";

const STEPS = [
  { label: "Understanding your question...", delay: 0, emoji: "🙏" },
  { label: "Searching 27 books...", delay: 500, emoji: "📚" },
  { label: "Finding relevant verses...", delay: 1500, emoji: "🔍" },
  { label: "Composing answer from Prabhupāda's words...", delay: 3000, emoji: "✨" },
];

interface SearchProgressProps {
  isSearching: boolean;
}

export default function SearchProgress({ isSearching }: SearchProgressProps) {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    if (!isSearching) {
      setActiveStep(0);
      return;
    }

    const timers = STEPS.map((step, i) =>
      setTimeout(() => setActiveStep(i), step.delay)
    );

    return () => timers.forEach(clearTimeout);
  }, [isSearching]);

  if (!isSearching) return null;

  return (
    <div
      className="search-progress"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "60px 20px 40px",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
          maxWidth: 380,
        }}
      >
        {STEPS.map((step, i) => {
          const isActive = i === activeStep;
          const isDone = i < activeStep;

          return (
            <div
              key={step.label}
              className="font-body"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 16px",
                borderRadius: 14,
                background: isActive
                  ? "rgba(139,92,246,0.08)"
                  : isDone
                    ? "rgba(16,185,129,0.06)"
                    : "rgba(255,255,255,0.4)",
                border: `1px solid ${
                  isActive
                    ? "rgba(139,92,246,0.25)"
                    : isDone
                      ? "rgba(16,185,129,0.2)"
                      : "rgba(196,181,253,0.15)"
                }`,
                opacity: i <= activeStep ? 1 : 0.35,
                transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                transform: i <= activeStep ? "translateX(0)" : "translateX(8px)",
              }}
            >
              {/* Status icon */}
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  flexShrink: 0,
                  background: isDone
                    ? "linear-gradient(135deg, #10B981, #059669)"
                    : isActive
                      ? "linear-gradient(135deg, #8B5CF6, #7C3AED)"
                      : "rgba(196,181,253,0.2)",
                  ...(isActive ? { animation: "searchStepPulse 1.8s ease-in-out infinite" } : {}),
                }}
              >
                {isDone ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <span style={{ filter: isActive ? "none" : "grayscale(1)", fontSize: 12 }}>
                    {step.emoji}
                  </span>
                )}
              </div>

              {/* Label */}
              <span
                style={{
                  fontSize: 14,
                  fontWeight: isActive ? 600 : isDone ? 500 : 400,
                  color: isActive ? "#7C3AED" : isDone ? "#059669" : "#6B7280",
                  transition: "all 0.3s ease",
                }}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
