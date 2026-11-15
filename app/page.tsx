/**
 * page.tsx — Home Page
 *
 * The cinematic redesign's home: the doorway (one full-screen photograph that
 * changes every 7 seconds, "Ask / Śrīla Prabhupāda", one rotating verse; tap
 * anywhere to continue), then Ask — the dark hero with the search box, three
 * sample questions, the library numbers and the three trust cards.
 *
 * All interaction and motion lives in the AskHome client component.
 * Submitting a question hands off to /search?q=…. Internal links back here
 * carry ?entrance=0 so navigation never replays the doorway.
 *
 * The lock-screen photo discovery still runs here at build time so a corrupt or
 * unsupported photo in public/images/lockscreen/ keeps failing the build with
 * its filename; the doorway itself shows the two ordered redesign photo sets.
 */
import AskHome from "./components/cinematic/19-ask-home";
import { getLockscreenSlideshowImages } from "./lib/server/01-lockscreen-images";

export const dynamic = "force-static";

export default async function Home() {
  await getLockscreenSlideshowImages();
  return <AskHome />;
}
