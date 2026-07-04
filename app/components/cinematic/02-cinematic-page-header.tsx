/**
 * 02-cinematic-page-header.tsx — Cinematic Sub-Page Header
 *
 * The lighter header shared by the cinematic reading pages (His Journey,
 * Features, How It Works, Search Results). Fixed, frosted, and scroll-reactive
 * (border + shadow appear once the page scrolls), it carries the brand and the
 * four primary nav links with the active one highlighted. A faithful port of the
 * <header> in each linked Claude Design prototype.
 *
 * "Search" points at the home route with the `ask` flag so it lands straight on
 * the search hero and skips the cinematic entrance (see 01-cinematic-home).
 */
"use client";

import Link from "next/link";
import { CSSProperties, useEffect, useState } from "react";

type Active = "search" | "journey" | "features" | "how";

const NAV: { key: Active; label: string; href: string }[] = [
  { key: "search", label: "Search", href: "/?ask=1" },
  { key: "journey", label: "His Journey", href: "/journey" },
  { key: "features", label: "Features", href: "/features" },
  { key: "how", label: "How it works", href: "/how-it-works" },
];

export default function CinematicPageHeader({ active, forceScrolled = false }: { active: Active; forceScrolled?: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (forceScrolled) return; // Search Results pins the frosted look at every scroll position
    const h = () => setScrolled(window.scrollY > 20);
    h();
    window.addEventListener("scroll", h);
    return () => window.removeEventListener("scroll", h);
  }, [forceScrolled]);

  const hdr = forceScrolled || scrolled
    ? { bg: "linear-gradient(120deg, rgba(254,252,248,0.94), rgba(250,247,241,0.90))", border: "#E8E0D2", shadow: "0 1px 2px rgba(43,37,25,0.04), 0 10px 30px rgba(43,37,25,0.06)" }
    : { bg: "linear-gradient(120deg, rgba(254,252,248,0.82), rgba(250,247,241,0.74))", border: "transparent", shadow: "none" };

  const linkStyle = (isActive: boolean): CSSProperties => ({
    textDecoration: "none", display: "inline-flex", alignItems: "center",
    padding: "7px 16px", borderRadius: 9, fontSize: 14,
    fontWeight: isActive ? 500 : 400,
    background: isActive ? "rgba(107,87,201,0.16)" : "transparent",
    color: isActive ? "#51409A" : "#6E6353",
    lineHeight: 1, whiteSpace: "nowrap", transition: "color 0.3s",
  });

  return (
    <header style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, height: 60,
      background: hdr.bg, backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)",
      borderBottom: `1px solid ${hdr.border}`, padding: "0 clamp(20px,4vw,48px)",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      boxShadow: hdr.shadow, transition: "border-color 0.4s, background 0.4s, box-shadow 0.4s",
    }}>
      <Link href="/" className="font-display" style={{ textDecoration: "none", fontSize: "clamp(1rem, 3.5vw, 1.4rem)", fontWeight: 600, color: "#51409A", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>Ask Śrīla Prabhupāda</Link>
      <nav style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {NAV.map((n) => (
          <Link key={n.key} href={n.href} className={n.key === active ? "font-body" : "cine-nav-link font-body"} style={linkStyle(n.key === active)}>{n.label}</Link>
        ))}
      </nav>
    </header>
  );
}
