// app/_components/TopNav.tsx
"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";

export default function TopNav() {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // close popup when clicking outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  return (
    <header className="h-16 sticky top-0 z-50 bg-white/70 backdrop-blur border-b border-black/5">
      <nav className="mx-auto max-w-6xl h-full px-4 sm:px-6 flex items-center justify-between">
        {/* Title stays on a single line */}
        <Link
          href="/"
          className="font-semibold tracking-tight whitespace-nowrap text-[15px] sm:text-base"
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
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
            className="p-2 rounded-lg border border-black/10 bg-white/80 shadow-sm active:scale-[0.98]"
          >
            {/* 3 lines icon */}
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>

          {open && (
            <div className="absolute right-0 mt-2 w-44 rounded-xl bg-white shadow-lg border border-black/10 overflow-hidden">
              <Link
                href="/team"
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm hover:bg-gray-50"
              >
                Team
              </Link>
              <Link
                href="/inspiration"
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm hover:bg-gray-50"
              >
                Inspiration
              </Link>
              <Link
                href="/updates"
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm hover:bg-gray-50"
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
