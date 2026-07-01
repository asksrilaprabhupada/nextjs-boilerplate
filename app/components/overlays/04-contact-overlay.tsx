/**
 * 04-contact-overlay.tsx — Contact Overlay
 *
 * Provides a contact form with name, email, and message fields.
 * Lets users reach out to the team with questions or feedback.
 */
"use client";

import { useState } from "react";

export default function ContactOverlay() {
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
        body: JSON.stringify({ type: "contact", name: name || null, email: email || null, message: message.trim() }),
      });
      if (res.ok) {
        setSent(true);
        setName(""); setEmail(""); setMessage("");
      }
    } catch { /* silent */ }
    finally { setSending(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 16px", borderRadius: 12,
    border: "1px solid color-mix(in srgb, var(--accent-tint) 30%, transparent)", background: "color-mix(in srgb, var(--surface-raised) 60%, transparent)",
    color: "var(--ink)", fontSize: 15, fontFamily: "var(--font-body), 'DM Sans', sans-serif", fontWeight: 400, outline: "none",
    transition: "border-color 0.3s ease, box-shadow 0.3s ease",
  };

  if (sent) {
    return (
      <div style={{ textAlign: "center", padding: "40px 0" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🙏</div>
        <h2 className="font-display" style={{ fontSize: "1.4rem", fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>Message sent!</h2>
        <p className="font-body" style={{ fontSize: 15, color: "var(--ink-muted)" }}>We&apos;ll get back to you soon. Hare Kṛṣṇa!</p>
        <button onClick={() => setSent(false)} className="font-body" style={{ marginTop: 20, padding: "8px 20px", borderRadius: 10, border: "1px solid color-mix(in srgb, var(--accent-tint) 30%, transparent)", background: "transparent", color: "var(--accent-strong)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
          Send another message
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="font-display" style={{ fontSize: "1.6rem", fontWeight: 600, color: "var(--ink)", marginBottom: 8, letterSpacing: "-0.02em" }}>Get in touch</h2>
      <p className="font-body" style={{ fontSize: 14, color: "var(--ink-muted)", marginBottom: 20 }}>Your message will be sent directly to the team. We read every message.</p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-muted)", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: "0.1em" }}>Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)"; }}
            onBlur={e => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent-tint) 30%, transparent)"; e.currentTarget.style.boxShadow = "none"; }}
          />
        </div>
        <div>
          <label className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-muted)", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: "0.1em" }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com (so we can reply)" style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)"; }}
            onBlur={e => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent-tint) 30%, transparent)"; e.currentTarget.style.boxShadow = "none"; }}
          />
        </div>
        <div>
          <label className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-muted)", marginBottom: 6, display: "block", textTransform: "uppercase", letterSpacing: "0.1em" }}>Message</label>
          <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Your message..." rows={5}
            style={{ ...inputStyle, resize: "vertical", minHeight: 100 }}
            onFocus={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)"; }}
            onBlur={e => { e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent-tint) 30%, transparent)"; e.currentTarget.style.boxShadow = "none"; }}
          />
        </div>
        <button type="submit" disabled={!message.trim() || sending} className="btn-primary" style={{ width: "100%", justifyContent: "center", opacity: message.trim() ? 1 : 0.5 }}>
          <span>{sending ? "Sending..." : "Send Message"}</span>
        </button>
      </form>
    </div>
  );
}