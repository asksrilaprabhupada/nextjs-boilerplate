"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { logFeedback } from "../lib/analytics";

interface SearchFeedbackProps {
  searchLogId: string | null;
}

export default function SearchFeedback({ searchLogId }: SearchFeedbackProps) {
  const [vote, setVote] = useState<1 | -1 | null>(null);
  const [showTextInput, setShowTextInput] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const handleVote = useCallback(async (v: 1 | -1) => {
    if (!searchLogId || vote !== null) return;
    setVote(v);

    // Thumbs down → show text input for why
    if (v === -1) {
      setShowTextInput(true);
    } else {
      // Thumbs up → send immediately
      setSending(true);
      await logFeedback(searchLogId, v);
      setSending(false);
      setSubmitted(true);
    }
  }, [searchLogId, vote]);

  const handleSubmitText = useCallback(async () => {
    if (!searchLogId || vote === null) return;
    setSending(true);
    await logFeedback(searchLogId, vote, feedbackText.trim() || undefined);
    setSending(false);
    setShowTextInput(false);
    setSubmitted(true);
  }, [searchLogId, vote, feedbackText]);

  const handleSkipText = useCallback(async () => {
    if (!searchLogId || vote === null) return;
    setSending(true);
    await logFeedback(searchLogId, vote);
    setSending(false);
    setShowTextInput(false);
    setSubmitted(true);
  }, [searchLogId, vote]);

  if (!searchLogId) return null;

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: 12, padding: "20px 0 4px", marginTop: 8,
      borderTop: "1px solid rgba(196,181,253,0.15)",
    }}>
      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="thanks"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ fontSize: 16 }}>🙏</span>
            <span className="font-body" style={{
              fontSize: 13, fontWeight: 500, color: "#7C3AED",
            }}>
              Thank you for your feedback
            </span>
          </motion.div>
        ) : showTextInput ? (
          <motion.div
            key="text-input"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 10, width: "100%", maxWidth: 420,
            }}
          >
            <p className="font-body" style={{
              fontSize: 13, color: "#6B7280", textAlign: "center",
            }}>
              What could be improved?
            </p>
            <textarea
              value={feedbackText}
              onChange={e => setFeedbackText(e.target.value)}
              placeholder="The answer didn't address..., Wrong verses were shown..., etc."
              className="font-body"
              rows={3}
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 12,
                border: "1px solid rgba(196,181,253,0.3)",
                background: "rgba(255,255,255,0.6)", fontSize: 13,
                color: "#1E1B4B", outline: "none", resize: "vertical",
                minHeight: 60, transition: "border-color 0.3s",
              }}
              onFocus={e => { e.currentTarget.style.borderColor = "#8B5CF6"; }}
              onBlur={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleSubmitText}
                disabled={sending}
                className="font-body"
                style={{
                  padding: "7px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: "linear-gradient(135deg, #8B5CF6, #7C3AED)",
                  color: "#fff", border: "none", cursor: "pointer",
                  transition: "opacity 0.2s",
                  opacity: sending ? 0.6 : 1,
                }}
              >
                {sending ? "Sending..." : "Submit"}
              </button>
              <button
                onClick={handleSkipText}
                disabled={sending}
                className="font-body"
                style={{
                  padding: "7px 18px", borderRadius: 8, fontSize: 12, fontWeight: 500,
                  background: "transparent", color: "#6B7280",
                  border: "1px solid rgba(196,181,253,0.3)", cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                Skip
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="vote-buttons"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <span className="font-body" style={{
              fontSize: 12, color: "#6B7280", fontWeight: 500,
            }}>
              Was this helpful?
            </span>

            {/* Thumbs Up */}
            <button
              onClick={() => handleVote(1)}
              disabled={sending}
              aria-label="Thumbs up"
              style={{
                width: 36, height: 36, borderRadius: 10,
                border: "1px solid rgba(196,181,253,0.3)",
                background: vote === 1 ? "rgba(16,185,129,0.1)" : "rgba(255,255,255,0.6)",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                color: vote === 1 ? "#059669" : "#6B7280",
              }}
              onMouseEnter={e => {
                if (!vote) {
                  e.currentTarget.style.background = "rgba(16,185,129,0.08)";
                  e.currentTarget.style.borderColor = "rgba(16,185,129,0.3)";
                  e.currentTarget.style.color = "#059669";
                  e.currentTarget.style.transform = "translateY(-1px)";
                }
              }}
              onMouseLeave={e => {
                if (!vote) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.6)";
                  e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
                  e.currentTarget.style.color = "#6B7280";
                  e.currentTarget.style.transform = "translateY(0)";
                }
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m7-2V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Thumbs Down */}
            <button
              onClick={() => handleVote(-1)}
              disabled={sending}
              aria-label="Thumbs down"
              style={{
                width: 36, height: 36, borderRadius: 10,
                border: "1px solid rgba(196,181,253,0.3)",
                background: vote === -1 ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.6)",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                color: vote === -1 ? "#DC2626" : "#6B7280",
              }}
              onMouseEnter={e => {
                if (!vote) {
                  e.currentTarget.style.background = "rgba(239,68,68,0.06)";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.3)";
                  e.currentTarget.style.color = "#DC2626";
                  e.currentTarget.style.transform = "translateY(-1px)";
                }
              }}
              onMouseLeave={e => {
                if (!vote) {
                  e.currentTarget.style.background = "rgba(255,255,255,0.6)";
                  e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
                  e.currentTarget.style.color = "#6B7280";
                  e.currentTarget.style.transform = "translateY(0)";
                }
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M17 2H19.67a2 2 0 0 1 2 1.7l.33 2.3h0a2 2 0 0 1-2 2.3H14l1 4.5V17a3 3 0 0 1-3 3l-4-9V2h9zM7 2v11H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h3z"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}