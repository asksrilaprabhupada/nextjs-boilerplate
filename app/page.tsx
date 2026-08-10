/**
 * page.tsx — Home Page
 *
 * Renders the cinematic home page: the doorway entrance (one composed frame —
 * photograph, wordmark, one rotating verse; no button, no skip, no audio),
 * then the search itself — gradient wordmark, search bar, library count-up,
 * the Moments filmstrip, the manifesto, a sharp 1965 journey teaser, sample
 * voices, and a quiet closing door.
 *
 * All interaction and motion lives in the CinematicHome client component.
 * Submitting a question hands off to the woven-answer results route
 * (`/search?q=…`); see CinematicHome's `runSearch`. Internal links back here
 * carry ?entrance=0 so navigation never replays the doorway.
 */
import CinematicHome from "./components/cinematic/01-cinematic-home";
import { getLockscreenSlideshowImages } from "./lib/server/01-lockscreen-images";

export const dynamic = "force-static";

export default async function Home() {
  const introImages = await getLockscreenSlideshowImages();
  return <CinematicHome introImages={introImages} />;
}
