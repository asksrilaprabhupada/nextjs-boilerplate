/**
 * 11-site-header.tsx — Unified Site Header (every route)
 *
 * One fixed, scroll-reactive header for the whole site: brand, Search · His
 * Journey · Features · How it works, and a "More ▾" dropdown (Support the seva
 * · Request a feature · Send feedback · GitHub · theme toggle) that opens the
 * shared modals from any page. Active link gets the pill (home and /search
 * both count as Search). Below ~880px the links collapse into a hamburger with
 * a slide-down sheet.
 *
 * Three variants:
 *   • "solid"   — always frosted paper (search results).
 *   • "overlay" — genuinely transparent at rest, frosting in once the page
 *                 scrolls (home, features, how it works).
 *   • "scene"   — scene-aware: a soft dark scrim with light type while the
 *                 viewport is still over a dark opening scene, turning into
 *                 frosted paper below it (His Journey). This is what stops a
 *                 pale bar from sitting on top of a dark cinematic frame.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CSSProperties, useEffect, useState } from "react";
import ThemeToggle from "../layout/03-theme-toggle";
import { useSiteModals } from "./13-site-modals";

const GITHUB_URL = "https://github.com/asksrilaprabhupada/nextjs-boilerplate";

export type HeaderVariant = "overlay" | "solid" | "scene";

const NAV: { key: string; label: string; href: string; match: (p: string) => boolean }[] = [
  { key: "search", label: "Search", href: "/?entrance=0", match: (p) => p === "/" || p.startsWith("/search") },
  { key: "journey", label: "His Journey", href: "/journey", match: (p) => p.startsWith("/journey") },
  { key: "features", label: "Features", href: "/features", match: (p) => p.startsWith("/features") },
  { key: "how", label: "How it works", href: "/how-it-works", match: (p) => p.startsWith("/how-it-works") },
];

const linkBase: CSSProperties = {
  textDecoration: "none", display: "inline-flex", alignItems: "center", padding: "7px 16px",
  minHeight: 44, borderRadius: 9, fontSize: 14, lineHeight: 1, whiteSpace: "nowrap", transition: "color 0.4s, background 0.4s",
};

const PAPER = {
  bg: "linear-gradient(120deg, rgba(254,252,248,0.94), rgba(250,247,241,0.90))",
  blur: "blur(16px) saturate(1.1)",
  border: "#E8E0D2",
  shadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)",
} as const;

export default function SiteHeader({ variant = "solid" }: { variant?: HeaderVariant }) {
  const pathname = usePathname() || "/";
  const { openModal } = useSiteModals();
  const [scrolled, setScrolled] = useState(variant === "solid");
  // Journey opens over a full-viewport dark frame — true while we are still on it.
  const [overDark, setOverDark] = useState(variant === "scene");
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (variant === "solid") return;
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
      if (variant === "scene") setOverDark(window.scrollY < window.innerHeight - 120);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [variant]);

  // Close menus on route change.
  useEffect(() => { setMoreOpen(false); setMenuOpen(false); }, [pathname]);

  // The mobile sheet is paper in every variant, so the bar above it must be too.
  const dark = variant === "scene" && overDark && !menuOpen;
  const paper = variant === "solid" || menuOpen || (variant === "overlay" && scrolled) || (variant === "scene" && !overDark);

  const hdr = dark
    ? { bg: "linear-gradient(180deg, rgba(22,18,12,0.55), rgba(22,18,12,0))", blur: "none", border: "transparent", shadow: "none" }
    : paper
      ? PAPER
      : { bg: "transparent", blur: "none", border: "transparent", shadow: "none" };

  const brandColor = dark ? "#FFF8E8" : "#51409A";
  const linkColor = dark ? "rgba(255,248,232,0.75)" : "#6E6353";
  const activeBg = dark ? "rgba(255,248,232,0.14)" : "rgba(107,87,201,0.16)";
  const activeColor = dark ? "#FFF8E8" : "#51409A";
  const hoverClass = dark ? "cine-nav-link-dark" : "cine-nav-link";

  const moreItems = [
    { title: "Support the seva", sub: "Keep his words freely searchable", on: () => { openModal("donate"); setMoreOpen(false); setMenuOpen(false); } },
    { title: "Request a feature", sub: "Shape what comes next", on: () => { openModal("feature"); setMoreOpen(false); setMenuOpen(false); } },
    { title: "Send feedback", sub: "Two minutes, from the heart", on: () => { openModal("feedback"); setMoreOpen(false); setMenuOpen(false); } },
  ];

  const navLink = (item: (typeof NAV)[number]) => {
    const active = item.match(pathname);
    return (
      <Link
        key={item.key}
        href={item.href}
        className={active ? "font-body" : `${hoverClass} font-body`}
        style={{
          ...linkBase,
          fontWeight: active ? 500 : 400,
          background: active ? activeBg : "transparent",
          color: active ? activeColor : linkColor,
        }}
      >
        {item.label}
      </Link>
    );
  };

  return (
    <>
      <header className="site-header" style={{ background: hdr.bg, backdropFilter: hdr.blur, WebkitBackdropFilter: hdr.blur, borderBottom: `1px solid ${hdr.border}`, boxShadow: hdr.shadow, transition: "border-color 0.4s, background 0.4s, box-shadow 0.4s" }}>
        <Link href="/?entrance=0" className="site-header__brand font-display" style={{ color: brandColor, transition: "color 0.4s" }}>Ask Śrīla Prabhupāda</Link>

        {/* Desktop nav */}
        <nav className="site-nav-desktop" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {NAV.map(navLink)}
          <div style={{ position: "relative", display: "flex" }}>
            <button onClick={() => setMoreOpen((v) => !v)} className={`${hoverClass} font-body`} aria-expanded={moreOpen} aria-haspopup="menu"
              style={{ ...linkBase, gap: 6, fontWeight: 400, background: moreOpen ? (dark ? "rgba(255,248,232,0.14)" : "rgba(107,87,201,0.10)") : "transparent", color: moreOpen ? activeColor : linkColor, border: "none", cursor: "pointer" }}>
              <span>More</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${moreOpen ? "180deg" : "0deg"})`, transition: "transform 0.35s cubic-bezier(0.16,1,0.3,1)" }}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {moreOpen && (
              <div role="menu" style={{ position: "absolute", top: "calc(100% + 14px)", right: 0, width: 248, background: "linear-gradient(160deg, rgba(254,252,248,0.98), rgba(250,247,241,0.97))", border: "1px solid rgba(107,87,201,0.14)", borderRadius: 18, boxShadow: "0 24px 70px rgba(43,37,25,0.18)", padding: 8, backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", animation: "morePanelIn 0.4s cubic-bezier(0.16,1,0.3,1) both", display: "flex", flexDirection: "column", gap: 2 }}>
                {moreItems.map((it) => (
                  <button key={it.title} onClick={it.on} className="cine-nav-menu-item font-body" style={{ textAlign: "left", padding: "11px 13px", borderRadius: 12, border: "none", background: "transparent", cursor: "pointer", transition: "background 0.25s" }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#2B2519" }}>{it.title}</span>
                    <span style={{ display: "block", fontSize: 12, color: "#9A8F7D", marginTop: 2 }}>{it.sub}</span>
                  </button>
                ))}
                <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="cine-nav-menu-item font-body" style={{ textDecoration: "none", textAlign: "left", padding: "11px 13px", borderRadius: 12, transition: "background 0.25s" }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#2B2519" }}>GitHub</span>
                  <span style={{ display: "block", fontSize: 12, color: "#9A8F7D", marginTop: 2 }}>The library is open source</span>
                </a>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 13px", borderTop: "1px solid rgba(107,87,201,0.10)", marginTop: 4 }}>
                  <span className="font-body" style={{ fontSize: 13, color: "#6E6353" }}>Theme</span>
                  <ThemeToggle />
                </div>
              </div>
            )}
          </div>
        </nav>

        {/* Mobile hamburger */}
        <button
          className="site-nav-burger"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          style={{ border: `1px solid ${dark ? "rgba(232,224,210,0.4)" : "#E8E0D2"}`, background: dark ? "transparent" : "rgba(254,252,248,0.9)", color: brandColor, cursor: "pointer", transition: "color 0.4s, border-color 0.4s, background 0.4s" }}
        >
          {menuOpen ? (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          )}
        </button>
      </header>

      {/* Click-away for the More dropdown */}
      {moreOpen && <div onClick={() => setMoreOpen(false)} aria-hidden style={{ position: "fixed", inset: 0, zIndex: 99, cursor: "default" }} />}

      {/* Mobile slide-down sheet */}
      {menuOpen && (
        <div className="site-nav-sheet" style={{ background: "linear-gradient(160deg, rgba(254,252,248,0.99), rgba(250,247,241,0.98))", borderBottom: "1px solid #E8E0D2", boxShadow: "0 24px 70px rgba(43,37,25,0.16)", animation: "morePanelIn 0.35s cubic-bezier(0.16,1,0.3,1) both" }}>
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link key={item.key} href={item.href} onClick={() => setMenuOpen(false)} className="font-body" style={{ textDecoration: "none", padding: "12px 10px", borderRadius: 10, fontSize: 15, fontWeight: active ? 500 : 400, color: active ? "#51409A" : "#2B2519", background: active ? "rgba(107,87,201,0.10)" : "transparent" }}>
                {item.label}
              </Link>
            );
          })}
          <div aria-hidden style={{ height: 1, background: "#E8E0D2", margin: "8px 0" }} />
          {moreItems.map((it) => (
            <button key={it.title} onClick={it.on} className="font-body" style={{ textAlign: "left", padding: "12px 10px", borderRadius: 10, border: "none", background: "transparent", fontSize: 15, color: "#2B2519", cursor: "pointer" }}>
              {it.title}
            </button>
          ))}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="font-body" style={{ textDecoration: "none", padding: "12px 10px", borderRadius: 10, fontSize: 15, color: "#2B2519" }}>GitHub</a>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 10px 0" }}>
            <span className="font-body" style={{ fontSize: 14, color: "#6E6353" }}>Theme</span>
            <ThemeToggle />
          </div>
        </div>
      )}

      <style jsx global>{`
        .site-header {
          position: fixed;
          top: 0;
          right: 0;
          left: 0;
          z-index: 100;
          box-sizing: border-box;
          height: calc(60px + env(safe-area-inset-top));
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-top: env(safe-area-inset-top);
          padding-right: max(clamp(20px, 4vw, 48px), env(safe-area-inset-right));
          padding-left: max(clamp(20px, 4vw, 48px), env(safe-area-inset-left));
        }

        .site-header__brand {
          min-width: 0;
          overflow: hidden;
          color: #51409a;
          font-size: clamp(1rem, 3.5vw, 1.4rem);
          font-weight: 600;
          letter-spacing: -0.01em;
          text-decoration: none;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .site-nav-burger {
          flex: 0 0 44px;
          width: 44px;
          height: 44px;
          display: none;
          align-items: center;
          justify-content: center;
          margin-left: 12px;
          border-radius: 10px;
        }

        .site-nav-sheet {
          position: fixed;
          top: calc(60px + env(safe-area-inset-top));
          right: 0;
          left: 0;
          z-index: 98;
          max-height: calc(100dvh - 60px - env(safe-area-inset-top));
          display: flex;
          flex-direction: column;
          gap: 2px;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding-top: 10px;
          padding-right: max(clamp(16px, 4vw, 32px), env(safe-area-inset-right));
          padding-bottom: max(18px, env(safe-area-inset-bottom));
          padding-left: max(clamp(16px, 4vw, 32px), env(safe-area-inset-left));
        }

        .site-nav-sheet > a,
        .site-nav-sheet > button {
          min-height: 44px;
        }

        .site-nav-sheet .theme-toggle {
          width: 44px;
          height: 44px;
        }

        .site-header :where(a, button):focus-visible,
        .site-nav-sheet :where(a, button):focus-visible {
          outline: 3px solid #51409a;
          outline-offset: 3px;
        }

        @media (max-height: 520px) and (orientation: landscape) {
          .site-nav-sheet {
            padding-top: 6px;
            padding-bottom: max(10px, env(safe-area-inset-bottom));
          }
        }
      `}</style>
    </>
  );
}
