// app/_components/TopNav.tsx
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export default function TopNav() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // close menu on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!open) return;
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  // close on Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="sticky top-0 z-[100] bg-white text-gray-900 shadow-sm border-b border-black/10">
      <nav className="mx-auto max-w-6xl h-16 px-4 sm:px-6 flex items-center justify-between">
        {/* Title (single line) */}
        <Link
          href="/"
          aria-label="Go to home"
          className="font-semibold tracking-tight whitespace-nowrap text-[16px] sm:text-base"
        >
          Ask Śrīla Prabhupāda
        </Link>

        {/* Desktop links (no Home) */}
        <div className="hidden md:flex items-center gap-6 text-sm">
          <Link href="/team" className="hover:text-gray-700">Team</Link>
          <Link href="/inspiration" className="hover:text-gray-700">Inspiration</Link>
          <Link href="/updates" className="hover:text-gray-700">Updates</Link>
        </div>

        {/* Mobile hamburger */}
        <div className="md:hidden relative">
          <button
            ref={btnRef}
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="p-2 rounded-xl bg-white border border-black/20 shadow-md text-gray-900 active:scale-[0.98]"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          {/* Dim page for contrast */}
          {open && (
            <div
              className="fixed inset-0 z-[90] bg-black/35"
              aria-hidden="true"
              onClick={() => setOpen(false)}
            />
          )}

          {/* Menu panel (high contrast) */}
          <div
            ref={panelRef}
            className={[
              "absolute right-0 mt-2 w-48 rounded-2xl bg-white text-gray-900",
              "shadow-2xl ring-1 ring-black/10 overflow-hidden z-[100]",
              "transition-all duration-150 origin-top-right",
              open ? "opacity-100 translate-y-0 scale-100" : "pointer-events-none opacity-0 -translate-y-1 scale-95",
            ].join(" ")}
          >
            <Link
              href="/team"
              onClick={() => setOpen(false)}
              className="block px-4 py-3 text-[15px] font-medium hover:bg-gray-50"
            >
              Team
            </Link>
            <Link
              href="/inspiration"
              onClick={() => setOpen(false)}
              className="block px-4 py-3 text-[15px] font-medium hover:bg-gray-50"
            >
              Inspiration
            </Link>
            <Link
              href="/updates"
              onClick={() => setOpen(false)}
              className="block px-4 py-3 text-[15px] font-medium hover:bg-gray-50"
            >
              Updates
            </Link>
          </div>
        </div>
      </nav>
    </header>
  );
}
