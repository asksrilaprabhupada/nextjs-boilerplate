/**
 * 11-site-header.tsx — The header on every page (cinematic redesign)
 *
 * The approved header (docs/redesign/designs/*.dc.html): the logo on the left —
 * gold face medallion, gold divider, "Ask / Śrīla Prabhupāda" logotype — and,
 * on the right, whatever the screen needs: the Warm Evening theme toggle by
 * default, "Cancel" while searching, a search box on the answer, "← Back to the
 * answer" in Dig Deeper. There is no navigation: His Journey, Features and How
 * it works are hidden for now, and Support the seva · Send feedback · GitHub
 * live in the footer.
 *
 * The header sits in the flow at the top of each screen's dark band (never a
 * fixed bar over the content), so it is always light type on dark.
 *
 * `variant` is accepted only so the retained, unmounted earlier pages still
 * compile; it no longer changes anything.
 */
"use client";

import type { ReactNode } from "react";
import BrandLink from "./15-brand";
import ThemeToggle from "../layout/03-theme-toggle";

export type HeaderVariant = "overlay" | "solid" | "scene";

export default function SiteHeader({
  right,
  className = "",
}: {
  /** The right-hand control(s). Defaults to the theme toggle. */
  right?: ReactNode;
  className?: string;
  /** Retained for the unmounted earlier pages; ignored. */
  variant?: HeaderVariant;
}) {
  return (
    <header className={`asp-hdr ${className}`.trim()}>
      <BrandLink />
      <div className="asp-hdr-right">{right ?? <ThemeToggle variant="scene" />}</div>
    </header>
  );
}
