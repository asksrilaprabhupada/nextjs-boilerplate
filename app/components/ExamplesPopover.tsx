"use client";

import { useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

const EXAMPLE_QUESTIONS = [
  { emoji: "🕉️", text: "What is sadhu sanga?" },
  { emoji: "🧘", text: "How to control the mind?" },
  { emoji: "☸️", text: "What is karma?" },
  { emoji: "✨", text: "The nature of the soul" },
  { emoji: "🪷", text: "What happens after death?" },
  { emoji: "💛", text: "What is pure devotional service?" },
  { emoji: "🙏", text: "How to be free from suffering?" },
  { emoji: "🌸", text: "What is the purpose of life?" },
  { emoji: "📿", text: "Why is chanting Hare Kṛṣṇa important?" },
  { emoji: "🌅", text: "What did Prabhupāda say about waking up early?" },
  { emoji: "🔥", text: "How to overcome anger?" },
  { emoji: "🙇", text: "What is the role of a spiritual master?" },
  { emoji: "🕊️", text: "How to detach from material desires?" },
  { emoji: "📖", text: "What is the difference between soul and Supersoul?" },
  { emoji: "🎯", text: "What is the goal of human life?" },
];

interface ExamplesPopupProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (question: string) => void;
}

function ExamplesPopupOverlay({ isOpen, onClose, onSelect }: ExamplesPopupProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  const handleSelect = (text: string) => {
    onSelect(text);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(30, 27, 75, 0.2)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 480,
              maxHeight: "75vh",
              overflowY: "auto",
              background: "rgba(255, 255, 255, 0.92)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              borderRadius: 22,
              padding: "28px 24px",
              boxShadow:
                "0 24px 80px rgba(139, 92, 246, 0.15), 0 8px 32px rgba(0,0,0,0.08)",
              border: "1px solid rgba(255, 255, 255, 0.7)",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 20,
              }}
            >
              <div>
                <p
                  className="font-body"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    color: "#7C3AED",
                    marginBottom: 4,
                  }}
                >
                  Example Questions
                </p>
                <p
                  className="font-body"
                  style={{ fontSize: 13, color: "#6B7280" }}
                >
                  Tap any question to fill the search bar
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 9,
                  border: "1px solid rgba(196, 181, 253, 0.25)",
                  background: "rgba(255, 255, 255, 0.6)",
                  color: "#6B7280",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  flexShrink: 0,
                  transition: "all 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(139,92,246,0.08)";
                  e.currentTarget.style.color = "#1E1B4B";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.6)";
                  e.currentTarget.style.color = "#6B7280";
                }}
              >
                ✕
              </button>
            </div>

            {/* Questions list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {EXAMPLE_QUESTIONS.map((q, i) => (
                <motion.button
                  key={q.text}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03, duration: 0.25 }}
                  onClick={() => handleSelect(q.text)}
                  className="font-body"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    borderRadius: 14,
                    border: "1px solid rgba(196, 181, 253, 0.15)",
                    background: "rgba(255, 255, 255, 0.5)",
                    fontSize: 15,
                    fontWeight: 400,
                    color: "#374151",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                    width: "100%",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(139,92,246,0.07)";
                    e.currentTarget.style.borderColor = "rgba(196,181,253,0.4)";
                    e.currentTarget.style.color = "#7C3AED";
                    e.currentTarget.style.transform = "translateX(4px)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.5)";
                    e.currentTarget.style.borderColor = "rgba(196,181,253,0.15)";
                    e.currentTarget.style.color = "#374151";
                    e.currentTarget.style.transform = "translateX(0)";
                  }}
                >
                  <span style={{ fontSize: 18, flexShrink: 0 }}>{q.emoji}</span>
                  <span>{q.text}</span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function ExamplesPopup(props: ExamplesPopupProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Portal to document.body so it escapes any parent overflow/stacking context
  if (!mounted) return null;

  return createPortal(
    <ExamplesPopupOverlay {...props} />,
    document.body
  );
}