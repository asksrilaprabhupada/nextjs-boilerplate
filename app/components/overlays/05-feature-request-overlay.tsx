/**
 * 05-feature-request-overlay.tsx — Feature Request Overlay
 *
 * Provides a form for users to submit feature ideas and suggestions.
 * Helps the team gather user input on how to improve the platform.
 */
"use client";

import { useState } from "react";

export default function FeatureRequestOverlay() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "feature", name: name || null, email: email || null, message: message.trim() }),
      });
      if (res.ok) { setSent(true); setName(""); setEmail(""); setMessage(""); }
    } catch { /* silent */ }
    finally { setSending(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 16px", borderRadius: 12,
    border: "1px solid rgba(196,181,253,0.3)", background: "rgba(255,255,255,0.6)",
    color: "#1E1B4B", fontSize: 15, fontFamily: "'DM Sans', sans-serif", fontWeight: 400, outline: "none",
    transition: "border-color 0.3s, box-shadow 0.3s",
  };

  if (sent) {
    return (
      <div style={{ textAlign: "center", padding: "40px 0" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>✨</div>
        <h2 className="font-display" style={{ fontSize: "1.4rem", fontWeight: 600, color: "#1E1B4B", marginBottom: 8 }}>Feature request received!</h2>
        <p className="font-body" style={{ fontSize: 15, color: "#6B7280" }}>We appreciate your ideas. Hare Kṛṣṇa!</p>
        <button onClick={() => setSent(false)} className="font-body" style={{ marginTop: 20, padding: "8px 20px", borderRadius: 10, border: "1px solid rgba(196,181,253,0.3)", background: "transparent", color: "#7C3AED", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
          Submit another idea
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="font-display" style={{ fontSize: "1.6rem", fontWeight: 600, color: "#1E1B4B", marginBottom: 8, letterSpacing: "-0.02em" }}>Submit a Feature Request</h2>
      <p className="font-body" style={{ fontSize: 14, color: "#6B7280", marginBottom: 20 }}>
        Help us make Ask Śrīla Prabhupāda even better. What would you love to see?
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "#6B7280", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: "0.1em" }}>Your Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = "#8B5CF6"; }} onBlur={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; }} />
        </div>
        <div>
          <label className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "#6B7280", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: "0.1em" }}>Email (optional)</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = "#8B5CF6"; }} onBlur={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; }} />
        </div>
        <div>
          <label className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "#6B7280", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: "0.1em" }}>Feature Description</label>
          <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Describe the feature you'd like to see..." rows={5}
            style={{ ...inputStyle, resize: "vertical", minHeight: 100 }}
            onFocus={e => { e.currentTarget.style.borderColor = "#8B5CF6"; }} onBlur={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; }} />
        </div>
        <button type="submit" disabled={!message.trim() || sending} className="btn-primary" style={{ width: "100%", justifyContent: "center", opacity: message.trim() ? 1 : 0.5 }}>
          <span>{sending ? "Submitting..." : "Submit Feature Request"}</span>
        </button>
      </form>
    </div>
  );
}