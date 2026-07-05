/**
 * 12-site-footer.tsx — Unified Site Footer (every route)
 *
 * The quiet footer shared by all pages: copyright, GitHub, Support-the-seva
 * and Send-feedback (both open the shared modals), plus "← Back to search" on
 * inner pages (hidden on the home route, which IS the search).
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSiteModals } from "./13-site-modals";

const GITHUB_URL = "https://github.com/asksrilaprabhupada/nextjs-boilerplate";

const quietLink: React.CSSProperties = {
  fontSize: 13, color: "#6E6353", textDecoration: "none", transition: "color 0.3s ease",
  background: "none", border: "none", padding: 0, cursor: "pointer",
};

export default function SiteFooter() {
  const pathname = usePathname() || "/";
  const { openModal } = useSiteModals();
  const isHome = pathname === "/";

  return (
    <footer style={{ borderTop: "1px solid #E8E0D2", padding: "20px clamp(20px,5vw,80px)", maxWidth: 1280, margin: "0 auto", width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
      <span className="font-body" style={{ fontSize: 13, color: "#6E6353" }}>© {new Date().getFullYear()} · All rights reserved</span>
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="cine-nav-link font-body" style={quietLink}>GitHub</a>
        <button onClick={() => openModal("donate")} className="cine-nav-link font-body" style={quietLink}>Support the seva</button>
        <button onClick={() => openModal("feedback")} className="cine-nav-link font-body" style={quietLink}>Send feedback</button>
        {!isHome && (
          <Link href="/" className="cine-backlink font-body" style={quietLink}>← Back to search</Link>
        )}
      </div>
    </footer>
  );
}
