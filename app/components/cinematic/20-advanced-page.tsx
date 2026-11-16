/**
 * 20-advanced-page.tsx — Advanced: the previous ācāryas' books (switched off)
 *
 * Designs: docs/redesign/designs/Advanced.dc.html and PhoneAdvanced.dc.html.
 * Built now, shown only when NEXT_PUBLIC_ADVANCED_ENABLED is "true" (see
 * app/advanced/page.tsx and app/lib/28-advanced-flag.ts). The ācāryas' books
 * are NOT in the database yet, so this page never shows a passage: no sample,
 * no placeholder frame, no invented text. It offers the design's chooser
 * ("Choose the ācāryas") and says plainly that nothing can be searched yet.
 * Wiring a real search here is later work and must not touch the main search.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import SiteHeader from "./11-site-header";
import SiteFooter from "./12-site-footer";
import { buildSearchHref } from "@/app/lib/22-search-navigation";

const ACARYAS = [
  "Śrī Caitanya Mahāprabhu",
  "Svarūpa Dāmodara Gosvāmī",
  "Śrīla Rūpa Gosvāmī",
  "Śrīla Sanātana Gosvāmī",
  "Śrīla Raghunātha dāsa Gosvāmī",
  "Śrīla Jīva Gosvāmī",
  "Śrīla Kṛṣṇadāsa Kavirāja Gosvāmī",
  "Śrīla Narottama dāsa Ṭhākura",
  "Śrīla Viśvanātha Cakravartī Ṭhākura",
  "Śrīla Baladeva Vidyābhūṣaṇa",
  "Śrīla Jagannātha dāsa Bābājī",
  "Śrīla Bhaktivinoda Ṭhākura",
  "Śrīla Gaurakiśora dāsa Bābājī",
  "Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura",
];

export default function AdvancedPage({ q }: { q: string }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const everyone = chosen.length === 0;
  const answerHref = q ? buildSearchHref(q) : "/?entrance=0";
  const backLabel = q ? "← Śrīla Prabhupāda's answer" : "← Ask Śrīla Prabhupāda";

  const toggle = (name: string) =>
    setChosen((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));

  return (
    <div className="asp-page asp-adv-page">
      <section className="asp-adv-top" aria-label="Your question">
        <div aria-hidden="true" className="asp-adv-glow-a asp-drift" />
        <div aria-hidden="true" className="asp-adv-glow-b asp-drift" />
        <div aria-hidden="true" className="asp-grain" />
        <SiteHeader
          right={
            <Link className="asp-adv-back" href={answerHref} aria-label={backLabel.replace("← ", "")}>
              <span aria-hidden="true" className="asp-not-phone">{backLabel}</span>
              <span aria-hidden="true" className="asp-only-phone">{q ? "← Answer" : "← Ask"}</span>
            </Link>
          }
        />
        <div className="asp-adv-head asp-sec">
          <p className="asp-eyebrow asp-rise">{q ? "You asked · Advanced" : "Advanced"}</p>
          {q && <h1 className="asp-adv-q asp-rise" style={{ animationDelay: "100ms" }}>{q}</h1>}
          <p className="asp-adv-chip asp-rise" style={{ animationDelay: "200ms" }}>The previous ācāryas&apos; books · English translations</p>
        </div>
      </section>

      <main className="asp-adv-main asp-sec">
        <div className="asp-adv-col">
          <section className="asp-adv-pick" aria-labelledby="asp-pick-h">
            <div className="asp-adv-pick-head">
              <h2 id="asp-pick-h">Choose the ācāryas</h2>
              <p className="asp-adv-summary" role="status">
                {everyone ? `Showing all ${ACARYAS.length} ācāryas` : `Showing ${chosen.length} ${chosen.length === 1 ? "ācārya" : "ācāryas"}`}
              </p>
            </div>
            <div className="asp-adv-chips" role="group" aria-label="Ācāryas">
              <button type="button" className="asp-adv-chipbtn" aria-pressed={everyone} onClick={() => setChosen([])}>
                All ācāryas
              </button>
              {ACARYAS.map((name) => {
                const on = chosen.includes(name);
                return (
                  <button key={name} type="button" className="asp-adv-chipbtn" aria-pressed={on} onClick={() => toggle(name)}>
                    {on ? "✓ " : ""}
                    {name}
                  </button>
                );
              })}
            </div>
            <p className="asp-adv-hint">Pick one, several, or all. In story order, from Śrī Caitanya Mahāprabhu to Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura.</p>
          </section>

          <aside className="asp-adv-about" aria-label="About these passages">
            <p>These are the ācāryas&apos; own books in English translation, not Śrīla Prabhupāda&apos;s words. Every passage names its translator. Read each one in full before you rely on it.</p>
          </aside>

          <p className="asp-adv-empty">
            The ācāryas&apos; books are not in the library yet, so there are no passages to show here.
          </p>

          <div className="asp-adv-end">
            <p>These passages come from translations. Read each one in full in the book, and ask senior devotees when something is unclear. We cannot take responsibility for how a passage is understood.</p>
            <Link className="asp-adv-backbtn" href={answerHref}>
              {q ? "Back to Śrīla Prabhupāda's answer" : "Ask Śrīla Prabhupāda"}
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
