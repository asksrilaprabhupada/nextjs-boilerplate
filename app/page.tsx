/**
 * page.tsx — Home Page
 *
 * Renders the cinematic main page (v2): a single continuous cinematic scroll —
 * title-sequence entrance, ambient hero + search, library count-up, pinned
 * horizontal gallery, per-word manifesto scrub, editorial "why different" rows,
 * a 1965 journey teaser, a rotating testimonial, and a full-bleed CTA — plus the
 * nav "More" menu and cinematic Donate / Feature-request / Feedback pop-ups.
 *
 * All interaction and motion lives in the CinematicHome client component. When
 * a question is submitted it plays the meditative search moment and then hands
 * off to the woven-answer results route (`/search?q=…`); see CinematicHome's
 * `runSearch` — the integration seam to the real search backend.
 */
import CinematicHome from "./components/cinematic/01-cinematic-home";

export default function Home() {
  return <CinematicHome />;
}
