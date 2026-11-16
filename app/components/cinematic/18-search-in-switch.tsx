/**
 * 18-search-in-switch.tsx — "Search in": Śrīla Prabhupāda (default) · Advanced
 *
 * The switch under the search box in docs/redesign/designs/Ask.dc.html and
 * PhoneAsk.dc.html. It is built but rendered only when
 * NEXT_PUBLIC_ADVANCED_ENABLED is "true" (app/lib/28-advanced-flag.ts): the
 * previous ācāryas' books are not in the database yet, so by default the Ask
 * page shows no switch at all. Choosing Advanced sends the question to the
 * Advanced page instead of the normal search; it never changes the search.
 */
"use client";

import { Medallion } from "./15-brand";

export type SearchScope = "prabhupada" | "advanced";

function AcaryasIcon() {
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#d9b76a" strokeWidth="1.3">
      <circle cx="6" cy="12" r="3.6" strokeOpacity="0.55" />
      <circle cx="12" cy="12" r="3.6" strokeOpacity="0.8" />
      <circle cx="18" cy="12" r="3.6" />
      <circle cx="18" cy="12" r="1.2" fill="#d9b76a" stroke="none" />
    </svg>
  );
}

export default function SearchInSwitch({
  value,
  onChange,
}: {
  value: SearchScope;
  onChange: (scope: SearchScope) => void;
}) {
  return (
    <div className="asp-searchin asp-rise" style={{ animationDelay: "420ms" }}>
      <p id="asp-lib-lbl" className="asp-searchin-lbl">Search in</p>
      <div className="asp-segwrap" role="group" aria-labelledby="asp-lib-lbl">
        <button
          type="button"
          className="asp-seg"
          aria-pressed={value === "prabhupada"}
          onClick={() => onChange("prabhupada")}
        >
          {value === "prabhupada" && <span className="asp-seg-glint asp-glint" aria-hidden="true" />}
          <span className="asp-seg-body">
            <Medallion />
            <span className="asp-seg-text">
              <span className="asp-seg-name">Śrīla Prabhupāda</span>
              <span className="asp-seg-sub">Default</span>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="asp-seg"
          aria-pressed={value === "advanced"}
          onClick={() => onChange("advanced")}
        >
          {value === "advanced" && <span className="asp-seg-glint asp-glint" aria-hidden="true" />}
          <span className="asp-seg-body">
            <span aria-hidden="true" className="asp-seg-ico">
              <AcaryasIcon />
            </span>
            <span className="asp-seg-text">
              <span className="asp-seg-name">Advanced</span>
              <span className="asp-seg-sub">Previous ācāryas</span>
            </span>
          </span>
        </button>
      </div>
      <p className="asp-searchin-note">Advanced searches the previous ācāryas&apos; books</p>
    </div>
  );
}
