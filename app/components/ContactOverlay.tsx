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
    background: "var(--bg-deepest)",
    color: "var(--text-primary)",
    fontSize: "0.95rem",
    fontFamily: "'DM Sans', sans-serif",
    outline: "none",
    transition: "border-color 0.3s ease, box-shadow 0.3s ease",
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "var(--saffron)";
    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(212,122,10,0.08)";
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "var(--border-medium)";
    e.currentTarget.style.boxShadow = "none";
  };

  return (
    <div>
      <h2
        className="font-cormorant"
        style={{
          fontSize: "1.6rem",
          fontWeight: 500,
          color: "var(--text-primary)",
          marginBottom: 20,
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
            className="font-dm-sans"
            style={{
              fontSize: "0.78rem",
              fontWeight: 500,
              color: "var(--text-muted)",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
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
            className="font-dm-sans"
            style={{
              fontSize: "0.78rem",
              fontWeight: 500,
              color: "var(--text-muted)",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
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
            className="font-dm-sans"
            style={{
              fontSize: "0.78rem",
              fontWeight: 500,
              color: "var(--text-muted)",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
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
          className="font-dm-sans"
          style={{
            padding: "12px 24px",
            borderRadius: 12,
            border: "none",
            background: "var(--bg-hover)",
            color: "var(--text-primary)",
            fontSize: "0.88rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "all 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--saffron)";
            e.currentTarget.style.color = "#fff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
        >
          Send Message
        </button>
      </form>
    </div>
  );
}
