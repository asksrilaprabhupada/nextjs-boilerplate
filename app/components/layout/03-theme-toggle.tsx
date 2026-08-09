/**
 * 03-theme-toggle.tsx — Light / warm-evening theme toggle
 *
 * Opt-in dark mode: toggles the `.dark` class on <html> (which overrides only
 * the primitive design tokens) and remembers the choice in localStorage. The
 * app defaults to the light theme; a no-flash script in layout.tsx applies a
 * saved dark choice before paint.
 */
"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* ignore */ }
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to warm evening theme"}
      title={dark ? "Light theme" : "Evening theme"}
    >
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
      <style jsx>{`
        .theme-toggle {
          width: 40px;
          height: 40px;
          border-radius: var(--radius-full);
          border: 1px solid var(--border-hair);
          background: transparent;
          color: var(--ink-muted);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: color var(--dur-2) var(--ease-standard), border-color var(--dur-2) var(--ease-standard), background var(--dur-2) var(--ease-standard);
        }
        .theme-toggle:hover { color: var(--accent-strong); border-color: var(--accent); background: var(--accent-tint); }
        .theme-toggle:active { transform: scale(0.95); }
      `}</style>
    </button>
  );
}
