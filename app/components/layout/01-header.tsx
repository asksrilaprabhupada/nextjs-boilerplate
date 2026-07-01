/**
 * 01-header.tsx — Site Header
 *
 * Renders the sticky frosted-glass navigation bar with links to Search, Features, How It Works, and a dropdown for About, Donate, Contact, Feature Request overlays.
 * Provides the primary navigation across all pages.
 */
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CSSProperties, useEffect, useRef, useState } from "react";
import ThemeToggle from "./03-theme-toggle";

interface HeaderProps {
  onMoreItemSelect?: (item: "About" | "Donate" | "Contact" | "Feature Request") => void;
  onSearchClick?: () => void;
}

type MoreItem = "About" | "Donate" | "Contact" | "Feature Request";

const primaryNav = [
  { label: "Search", href: "/" },
  { label: "Features", href: "/features" },
  { label: "How it works", href: "/how-it-works" },
];

const moreItems: MoreItem[] = ["About", "Donate", "Contact", "Feature Request"];

export default function Header({ onMoreItemSelect, onSearchClick }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const h = () => setScrolled(window.scrollY > 20); h(); window.addEventListener("scroll", h); return () => window.removeEventListener("scroll", h); }, []);
  useEffect(() => { setMobileMenuOpen(false); setMoreOpen(false); setMobileMoreOpen(false); }, [pathname]);
  useEffect(() => { const h = (e: MouseEvent) => { if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) setMoreOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);

  const isActive = (href: string) => href === "/" ? pathname === "/" : pathname === href;

  const handleMoreItemClick = (item: MoreItem) => {
    setMoreOpen(false); setMobileMenuOpen(false);
    if (onMoreItemSelect && pathname === "/") { onMoreItemSelect(item); return; }
    const param = item === "Feature Request" ? "feature" : item.toLowerCase();
    router.push(`/?overlay=${param}`);
  };

  const navStyle = (active: boolean): CSSProperties => ({
    display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none",
    padding: "7px 16px", borderRadius: 9, fontSize: 14, fontWeight: active ? 500 : 400, border: "none",
    cursor: "pointer", transition: "all 0.3s ease",
    background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
    color: active ? "var(--accent-strong)" : "var(--ink-muted)", lineHeight: 1, whiteSpace: "nowrap",
  });

  return (
    <header style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, height: 60,
      background: scrolled
        ? "linear-gradient(120deg, color-mix(in srgb, var(--surface-raised) 94%, transparent), color-mix(in srgb, var(--surface) 90%, transparent))"
        : "linear-gradient(120deg, color-mix(in srgb, var(--surface-raised) 82%, transparent), color-mix(in srgb, var(--surface) 74%, transparent))",
      backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)",
      borderBottom: scrolled ? "1px solid var(--border-hair)" : "1px solid transparent",
      padding: "0 clamp(20px,4vw,48px)", display: "flex", alignItems: "center", justifyContent: "space-between",
      boxShadow: scrolled ? "var(--shadow-soft)" : "none", transition: "border-color 0.4s, background 0.4s, box-shadow 0.4s",
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="font-display" style={{ fontSize: "clamp(1rem, 3.5vw, 1.4rem)", fontWeight: 600, color: "var(--accent-strong)", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>Ask Śrīla Prabhupāda</span>
      </span>
      <nav style={{ display: "flex", alignItems: "center", gap: 8 }} className="desktop-nav">
        {primaryNav.map(item => (
          <Link key={item.label} href={item.href} className="font-body" style={navStyle(isActive(item.href))}
            onClick={item.label === "Search" && pathname === "/" && onSearchClick ? (e) => { e.preventDefault(); onSearchClick(); } : undefined}
          >{item.label}</Link>
        ))}
        <div style={{ position: "relative" }} ref={moreMenuRef}>
          <button onClick={() => setMoreOpen(p => !p)} className="font-body" style={{ ...navStyle(moreOpen), gap: 6 }}>
            More <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={moreOpen ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
          </button>
          {moreOpen && (
            <div role="menu" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, minWidth: 180, borderRadius: 14, background: "var(--surface-raised)", border: "1px solid var(--border-hair)", boxShadow: "var(--shadow-soft)", padding: 6 }}>
              {moreItems.map(item => (
                <button key={item} role="menuitem" onClick={() => handleMoreItemClick(item)} className="font-body"
                  style={{ width: "100%", border: "none", background: "transparent", color: "var(--ink)", padding: "10px 12px", borderRadius: 10, textAlign: "left", cursor: "pointer", fontSize: 14, fontWeight: 500 }}
                  onMouseEnter={e => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 14%, transparent)"; e.currentTarget.style.color = "var(--ink-strong)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--ink)"; }}
                >{item}</button>
              ))}
            </div>
          )}
        </div>
        <ThemeToggle />
      </nav>
      <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(p => !p)} aria-label="Toggle menu"
        style={{ display: "none", width: 40, height: 40, borderRadius: 10, border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {mobileMenuOpen ? <path d="M6 6l12 12M6 18L18 6" /> : <path d="M3 12h18M3 6h18M3 18h18" />}
        </svg>
      </button>
      {mobileMenuOpen && (
        <div style={{ position: "absolute", top: 60, left: 0, right: 0, background: "color-mix(in srgb, var(--surface-raised) 96%, transparent)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: "1px solid var(--border-hair)", padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
          {primaryNav.map(item => <Link key={item.label} href={item.href} className="font-body" onClick={(e) => { if (item.label === "Search" && pathname === "/" && onSearchClick) { e.preventDefault(); onSearchClick(); } setMobileMenuOpen(false); }} style={{ ...navStyle(isActive(item.href)), justifyContent: "flex-start", textDecoration: "none", padding: "10px 14px" }}>{item.label}</Link>)}
          <button onClick={() => setMobileMoreOpen(p => !p)} className="font-body" style={{ ...navStyle(mobileMoreOpen), justifyContent: "space-between", padding: "10px 14px" }}>
            <span>More</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={mobileMoreOpen ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
          </button>
          {mobileMoreOpen && (
            <div style={{ marginTop: 4, marginLeft: 8, paddingLeft: 10, borderLeft: "1px solid var(--border-firm)", display: "flex", flexDirection: "column", gap: 2 }}>
              {moreItems.map(item => <button key={item} onClick={() => handleMoreItemClick(item)} className="font-body" style={{ border: "none", background: "transparent", color: "var(--ink-muted)", padding: "10px 10px", textAlign: "left", borderRadius: 8, fontSize: 14, cursor: "pointer" }}>{item}</button>)}
            </div>
          )}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-hair)" }}><ThemeToggle /></div>
        </div>
      )}
    </header>
  );
}