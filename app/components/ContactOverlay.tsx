"use client";

import { useState } from "react";

export default function ContactOverlay() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 12,
    border: "1.5px solid var(--border-medium)",
    background: "var(--bg-lavender-soft)",
    color: "var(--text-primary)",
    fontSize: "0.95rem",
    fontFamily: "'Satoshi', sans-serif",
    outline: "none",
    transition: "border-color 0.3s ease, box-shadow 0.3s ease",
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "var(--indigo)";
    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(79,70,229,0.08)";
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "var(--border-medium)";
    e.currentTarget.style.boxShadow = "none";
  };

  return (
    <div>
      <h2
        className="font-satoshi"
        style={{
          fontSize: "1.5rem",
          fontWeight: 900,
          color: "var(--text-primary)",
          marginBottom: 20,
          letterSpacing: "-0.02em",
        }}
      >
        Get in touch
      </h2>
      <form
        onSubmit={(e) => e.preventDefault()}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div>
          <label
            className="font-satoshi"
            style={{
              fontSize: "0.75rem",
              fontWeight: 700,
              color: "var(--text-muted)",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            style={inputStyle}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        </div>
        <div>
          <label
            className="font-satoshi"
            style={{
              fontSize: "0.75rem",
              fontWeight: 700,
              color: "var(--text-muted)",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            style={inputStyle}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        </div>
        <div>
          <label
            className="font-satoshi"
            style={{
              fontSize: "0.75rem",
              fontWeight: 700,
              color: "var(--text-muted)",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Message
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Your message..."
            rows={5}
            style={{
              ...inputStyle,
              resize: "vertical",
              minHeight: 100,
            }}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        </div>
        <button
          type="submit"
          className="font-satoshi"
          style={{
            padding: "12px 24px",
            borderRadius: 12,
            border: "none",
            background: "var(--indigo)",
            color: "#fff",
            fontSize: "0.88rem",
            fontWeight: 700,
            cursor: "pointer",
            transition: "all 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--indigo-dark)";
            e.currentTarget.style.boxShadow = "var(--shadow-indigo-glow)";
            e.currentTarget.style.transform = "translateY(-1px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--indigo)";
            e.currentTarget.style.boxShadow = "none";
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          Send Message
        </button>
      </form>
    </div>
  );
}
