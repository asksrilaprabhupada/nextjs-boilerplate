/**
 * 01-feedback-button.tsx — Floating Feedback Button
 *
 * Renders a floating button in the bottom-right corner for submitting feedback, bug reports, or feature requests.
 * Provides a persistent way for users to share their experience from any page.
 */
"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  currentQuery?: string;
}

type FeedbackType = "feedback" | "feature" | "bug";

const typeLabels: Record<FeedbackType, { label: string; emoji: string; placeholder: string }> = {
  feedback: { label: "Feedback", emoji: "💬", placeholder: "How was this answer? What could be better?" },
  feature: { label: "Feature Request", emoji: "✨", placeholder: "What feature would make this more useful?" },
  bug: { label: "Report a Bug", emoji: "🐛", placeholder: "What went wrong? Please describe the issue." },
};

export default function FeedbackButton({ currentQuery }: Props) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>("feedback");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          email: email || null,
          message: message.trim(),
          query: currentQuery || null,
          page_url: typeof window !== "undefined" ? window.location.href : null,
        }),
      });
      setSubmitted(true);
      setTimeout(() => { setOpen(false); setSubmitted(false); setMessage(""); setEmail(""); }, 2000);
    } catch {
      // silent fail
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        style={{
          position: "fixed", bottom: 16, right: 16, zIndex: 90,
          width: 44, height: 44, borderRadius: 14,
          background: "linear-gradient(135deg, var(--accent), var(--accent-strong))",
          border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 8px 24px color-mix(in srgb, var(--accent) 30%, transparent)", transition: "transform 0.3s ease, box-shadow 0.3s ease",
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; e.currentTarget.style.boxShadow = "0 12px 32px color-mix(in srgb, var(--accent) 40%, transparent)"; }}
        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 8px 24px color-mix(in srgb, var(--accent) 30%, transparent)"; }}
        aria-label="Give feedback"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="var(--on-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Feedback panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 250, background: "color-mix(in srgb, var(--ink-strong) 15%, transparent)", backdropFilter: "blur(6px)" }}
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.95 }}
              transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
              onClick={e => e.stopPropagation()}
              style={{
                position: "fixed", bottom: 16, right: 16, width: 380, maxWidth: "calc(100vw - 32px)",
                background: "var(--surface-raised)", backdropFilter: "blur(24px)", borderRadius: 20,
                padding: "clamp(16px, 4vw, 24px) clamp(14px, 3.5vw, 20px)", boxShadow: "0 20px 60px color-mix(in srgb, var(--accent) 15%, transparent)", border: "1px solid var(--border-hair)",
              }}
            >
              {submitted ? (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🙏</div>
                  <p className="font-display" style={{ fontSize: "1.1rem", color: "var(--ink)", fontWeight: 600 }}>Thank you!</p>
                  <p className="font-body" style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 4 }}>Your {typeLabels[type].label.toLowerCase()} has been recorded.</p>
                </div>
              ) : (
                <>
                  {/* Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <p className="font-body" style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Share your thoughts</p>
                    <button onClick={() => setOpen(false)} style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid color-mix(in srgb, var(--accent-tint) 25%, transparent)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>✕</button>
                  </div>

                  {/* Type selector */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                    {(Object.keys(typeLabels) as FeedbackType[]).map(t => (
                      <button
                        key={t}
                        onClick={() => setType(t)}
                        className="font-body"
                        style={{
                          flex: 1, padding: "8px 6px", borderRadius: 10, fontSize: 12, fontWeight: 500,
                          border: type === t ? "1px solid var(--accent)" : "1px solid color-mix(in srgb, var(--accent-tint) 25%, transparent)",
                          background: type === t ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                          color: type === t ? "var(--accent-strong)" : "var(--ink-muted)",
                          cursor: "pointer", transition: "all 0.2s",
                        }}
                      >
                        {typeLabels[t].emoji} {typeLabels[t].label}
                      </button>
                    ))}
                  </div>

                  {/* Message */}
                  <textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder={typeLabels[type].placeholder}
                    className="font-body"
                    rows={4}
                    style={{
                      width: "100%", padding: "12px 14px", borderRadius: 12,
                      border: "1px solid color-mix(in srgb, var(--accent-tint) 30%, transparent)", background: "color-mix(in srgb, var(--surface-raised) 60%, transparent)",
                      fontSize: 14, color: "var(--ink)", outline: "none", resize: "vertical", minHeight: 80,
                      transition: "border-color 0.3s",
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                    onBlur={e => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent-tint) 30%, transparent)"; }}
                  />

                  {/* Email (optional) */}
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="Email (optional — for follow-up)"
                    className="font-body"
                    style={{
                      width: "100%", padding: "10px 14px", borderRadius: 10, marginTop: 8,
                      border: "1px solid color-mix(in srgb, var(--accent-tint) 30%, transparent)", background: "color-mix(in srgb, var(--surface-raised) 60%, transparent)",
                      fontSize: 13, color: "var(--ink)", outline: "none",
                    }}
                  />

                  {/* Submit */}
                  <button
                    onClick={handleSubmit}
                    disabled={!message.trim() || sending}
                    className="font-body"
                    style={{
                      width: "100%", marginTop: 12, padding: "10px 16px", borderRadius: 10,
                      background: message.trim() ? "linear-gradient(135deg, var(--accent), var(--accent-strong))" : "color-mix(in srgb, var(--accent-tint) 20%, transparent)",
                      color: message.trim() ? "var(--on-accent)" : "var(--ink-muted)",
                      border: "none", fontSize: 14, fontWeight: 500, cursor: message.trim() ? "pointer" : "default",
                      transition: "all 0.3s",
                    }}
                  >
                    {sending ? "Sending..." : "Submit"}
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}