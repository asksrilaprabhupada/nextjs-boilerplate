/**
 * 03-cinematic-page-footer.tsx — Cinematic Sub-Page Footer
 *
 * The quiet footer shared by the cinematic reading pages: a copyright line and a
 * "← Back to search" link home. Ported verbatim from the <footer> in each linked
 * Claude Design prototype.
 */
import Link from "next/link";

export default function CinematicPageFooter() {
  return (
    <footer style={{ borderTop: "1px solid #E8E0D2", padding: "20px clamp(20px,5vw,80px)", maxWidth: 1280, margin: "0 auto", width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
      <span className="font-body" style={{ fontSize: 13, color: "#6E6353" }}>© 2026 All rights reserved</span>
      <Link href="/" className="cine-backlink font-body" style={{ fontSize: 13, color: "#6E6353", textDecoration: "none", transition: "color 0.3s ease" }}>← Back to search</Link>
    </footer>
  );
}
