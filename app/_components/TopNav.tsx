"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export default function TopNav() {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // close dropdown when clicking outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  return (
    <header
      className="
        sticky top-0 z-50
        h-14 md:h-16
        bg-white md:bg-white/80 supports-[backdrop-filter]:backdrop-blur
        border-b border-black/5
        shadow-sm md:shadow-none
      "
    >
      <nav className="mx-auto max-w-6xl h-full px-3 sm:px-6 flex items-center justify-between">
        {/* Title – keep on one line, strong contrast on mobile */}
        <Link
          href="/"
          className="whitespace-nowrap font-semibold tracking-tight text-gray-900 text-[15px] sm:text-base"
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
        <div className="md:hidden relative" ref={popRef}>
          <button
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(v => !v)}
            className="p-2 rounded-xl border border-black/10 bg-white text-gray-700 shadow active:scale-[0.98]"
          >
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>

          {open && (
            <div
              className="
                absolute right-0 mt-2 w-48
                rounded-2xl bg-white shadow-xl ring-1 ring-black/10
                overflow-hidden z-50
              "
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
          )}
        </div>
      </nav>
    </header>
  );
}
