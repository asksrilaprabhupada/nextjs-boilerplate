/**
 * 15-brand.tsx — The logo: gold face medallion, gold divider, two-line logotype
 *
 * Copied from the header of every redesign screen (docs/redesign/designs/
 * Ask.dc.html) and the logo sheet (Logo.dc.html): his gold portrait in a gold
 * gradient ring, a thin vertical gold rule, then "Ask" in gold italic with a
 * hairline running out to the right, and "Śrīla Prabhupāda" in gold foil with a
 * soft glint crossing it every 8 seconds (.asp-foil). Desktop 40 px / 14 px /
 * 22 px; phone 34 px / 12 px / 18 px — the sizes live in app/redesign.css.
 *
 * `Medallion` is exported for the other places the face appears (the "Search
 * in" switch). The image is decorative; the link carries the accessible name.
 */
import Link from "next/link";

const FACE = "/images/redesign/logo/face-gold.webp";

export function Medallion({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`asp-med ${className}`.trim()}>
      <span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={FACE} alt="" width={40} height={40} decoding="async" />
      </span>
    </span>
  );
}

export function Logotype() {
  return (
    <span className="asp-logotype">
      <span className="asp-logo-ask">Ask</span>
      <span className="asp-logo-name-wrap" data-text="Śrīla Prabhupāda">
        <span className="asp-logo-name asp-foil">Śrīla Prabhupāda</span>
      </span>
    </span>
  );
}

/** The brand as a link home. Internal links home never replay the doorway. */
export default function BrandLink({ href = "/?entrance=0" }: { href?: string }) {
  return (
    <Link href={href} className="asp-brand" aria-label="Ask Śrīla Prabhupāda">
      <Medallion />
      <span aria-hidden="true" className="asp-brand-div" />
      <Logotype />
    </Link>
  );
}
