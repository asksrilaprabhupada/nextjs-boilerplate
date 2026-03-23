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
    border: "1px solid rgba(196, 181, 253, 0.3)",
    background: "rgba(255, 255, 255, 0.6)",
    color: "#1E1B4B",
    fontSize: 15,
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 400,
    outline: "none",
    transition: "border-color 0.3s ease, box-shadow 0.3s ease",
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "#8B5CF6";
    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(139,92,246,0.12)";
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "rgba(196, 181, 253, 0.3)";
    e.currentTarget.style.boxShadow = "none";
  };

  return (
    <div>
      <h2
        className="font-display"
        style={{
          fontSize: "1.6rem",
          fontWeight: 600,
          color: "#1E1B4B",
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
            className="font-body"
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "#9CA3AF",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
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
            className="font-body"
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "#9CA3AF",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
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
            className="font-body"
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "#9CA3AF",
              marginBottom: 6,
              display: "block",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
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
          className="btn-primary"
          style={{ width: "100%", justifyContent: "center" }}
        >
          <span>Send Message</span>
        </button>
      </form>
    </div>
  );
}
