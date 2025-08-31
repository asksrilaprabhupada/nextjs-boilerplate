// app/_components/TopNav.tsx
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export default function TopNav() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!open) return;
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="h-16 sticky top-0 z-[70] bg-white/85 backdrop-blur border-b border-black/5">
      <nav className="mx-auto max-w-6xl h-full px-4 sm:px-6 flex items-center justify-between">
        {/* Title (single line on mobile) */}
        <Link
          href="/"
          className="font-semibold tracking-tight whitespace-nowrap text-[15px] sm:text-base"
          aria-label="Go to home"
        >
          Ask Śrīla Prabhupāda
        </Link>

        {/* Desktop links (no Home) */}
        <div className="hidden md:flex items-center gap-6 text-sm">
          <Link href="/team" className="hover:underline">Team</Link>
          <Link href="/inspiration" className="hover:underline">Inspiration</Link>
          <Link href="/updates" className="hover:underline">Updates</Link>
        </div>

        {/* Mobile hamburger */}
        <div className="md:hidden relative">
          <button
            ref={btnRef}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="topnav-menu"
            onClick={() => setOpen((v) => !v)}
            className="p-2 rounded-lg border border-black/20 bg-white shadow-md active:scale-[0.98]"
          >
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>

          {/* Dim background when open (helps readability over photo) */}
          {open && (
            <div
              className="fixed inset-0 z-[60] bg-black/20"
              aria-hidden="true"
              onClick={() => setOpen(false)}
            />
          )}

          {/* Dropdown panel */}
          <div
            id="topnav-menu"
            ref={panelRef}
            className={[
              "absolute right-0 mt-2 w-48 rounded-xl bg-white/95 backdrop-blur",
              "shadow-2xl ring-1 ring-black/10 overflow-hidden z-[70]",
              open ? "opacity-100 translate-y-0" : "pointer-events-none opacity-0 -translate-y-1",
              "transition-all duration-150",
            ].join(" ")}
          >
            <Link
              href="/team"
              onClick={() => setOpen(false)}
              className="block px-4 py-3 text-[15px] hover:bg-gray-50"
            >
              Team
            </Link>
            <Link
              href="/inspiration"
              onClick={() => setOpen(false)}
              className="block px-4 py-3 text-[15px] hover:bg-gray-50"
            >
              Inspiration
            </Link>
            <Link
              href="/updates"
              onClick={() => setOpen(false)}
              className="block px-4 py-3 text-[15px] hover:bg-gray-50"
            >
              Updates
            </Link>
          </div>
        </div>
      </nav>
    </header>
  );
}
