/**
 * 12-site-footer.tsx — The footer on every page (cinematic redesign)
 *
 * Exactly three links, as the approved designs show: Support the seva (opens
 * the existing seva modal), Send feedback (opens the existing feedback form)
 * and GitHub. The home page also shows the name beside the copyright line.
 */
"use client";

import { useSiteModals } from "./13-site-modals";

const GITHUB_URL = "https://github.com/asksrilaprabhupada/nextjs-boilerplate";

export default function SiteFooter({ showName = false }: { showName?: boolean }) {
  const { openModal } = useSiteModals();
  const year = new Date().getFullYear();

  return (
    <footer className="asp-foot">
      <div className="asp-foot-inner">
        <div className="asp-foot-brand">
          {showName && <span className="asp-foot-name">Ask Śrīla Prabhupāda</span>}
          <span className="asp-foot-copy">© {year} · All rights reserved</span>
        </div>
        <nav aria-label="Footer">
          <button type="button" className="asp-foot-link" onClick={() => openModal("donate")}>
            Support the seva
          </button>
          <button type="button" className="asp-foot-link" onClick={() => openModal("feedback")}>
            Send feedback
          </button>
          <a className="asp-foot-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
