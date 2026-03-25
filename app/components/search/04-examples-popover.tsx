/**
 * 04-examples-popover.tsx — Examples Popover
 *
 * Shows example search questions as clickable pills with a "More examples" modal.
 * Helps users discover what kinds of questions they can ask about Srila Prabhupada's teachings.
 */
"use client";

import { useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

/* Two carefully chosen examples — one philosophical, one practical */
const VISIBLE_EXAMPLES = [
  { emoji: "🪷", text: "What is the purpose of human life?" },
  { emoji: "🧘", text: "How to control the mind?" },
];

const ALL_EXAMPLES = [
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

interface ExamplesPopoverProps {
  onSelect: (question: string) => void;
}

/* ──────────────────── Full-screen modal ──────────────────── */
function ExamplesModal({
  isOpen,
  onClose,
  onSelect,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (q: string) => void;
}) {
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
              {ALL_EXAMPLES.map((q, i) => (
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
                    e.currentTarget.style.borderColor =
                      "rgba(196,181,253,0.15)";
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

/* ──────────────────── Portal wrapper for modal ──────────────────── */
function ModalPortal(props: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (q: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(<ExamplesModal {...props} />, document.body);
}

/* ──────────────────── Main export: 2 pills + "more" ──────────────────── */
export default function ExamplesPopover({ onSelect }: ExamplesPopoverProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      {/* Inline pills — always visible, single row */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
        }}
      >
        {VISIBLE_EXAMPLES.map((q, i) => (
          <motion.button
            key={q.text}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              delay: 0.55 + i * 0.08,
              duration: 0.5,
              ease: [0.16, 1, 0.3, 1],
            }}
            onClick={() => onSelect(q.text)}
            className="font-body"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 14px",
              borderRadius: 100,
              border: "1px solid rgba(196, 181, 253, 0.3)",
              background: "rgba(255, 255, 255, 0.55)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              fontSize: 13,
              fontWeight: 400,
              color: "#374151",
              cursor: "pointer",
              transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(139,92,246,0.1)";
              e.currentTarget.style.borderColor = "rgba(139,92,246,0.35)";
              e.currentTarget.style.color = "#7C3AED";
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow =
                "0 4px 16px rgba(139,92,246,0.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.55)";
              e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
              e.currentTarget.style.color = "#374151";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <span style={{ fontSize: 14 }}>{q.emoji}</span>
            <span>{q.text}</span>
          </motion.button>
        ))}

        {/* Divider dot */}
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={{ delay: 0.75, duration: 0.4 }}
          style={{
            width: 3,
            height: 3,
            borderRadius: "50%",
            background: "#C4B5FD",
            flexShrink: 0,
          }}
        />

        {/* "More" trigger */}
        <motion.button
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            delay: 0.55 + VISIBLE_EXAMPLES.length * 0.08,
            duration: 0.5,
            ease: [0.16, 1, 0.3, 1],
          }}
          onClick={() => setModalOpen(true)}
          className="font-body"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "7px 14px",
            borderRadius: 100,
            border: "1px dashed rgba(139, 92, 246, 0.3)",
            background: "rgba(139, 92, 246, 0.04)",
            fontSize: 13,
            fontWeight: 500,
            color: "#7C3AED",
            cursor: "pointer",
            transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)",
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(139,92,246,0.12)";
            e.currentTarget.style.borderColor = "#8B5CF6";
            e.currentTarget.style.transform = "translateY(-2px)";
            e.currentTarget.style.boxShadow =
              "0 4px 16px rgba(139,92,246,0.15)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(139,92,246,0.04)";
            e.currentTarget.style.borderColor = "rgba(139,92,246,0.3)";
            e.currentTarget.style.transform = "translateY(0)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          More examples
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M5 12h14M12 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.button>
      </div>

      {/* Full modal (portaled) */}
      <ModalPortal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={(text) => {
          onSelect(text);
          setModalOpen(false);
        }}
      />
    </>
  );
}