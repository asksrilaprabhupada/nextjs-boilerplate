/**
 * journey/page.tsx — His Journey
 *
 * Server wrapper: SEO metadata around the cinematic five-chapter scroll film
 * (1965 Jaladuta crossing → seven dollars → Matchless Gifts → the books → the
 * world), opening over the Jaladuta photograph itself. All motion and
 * interaction live in the client component.
 */
import type { Metadata } from "next";
import JourneyPage from "../components/cinematic/05-journey-page";
import { getLockscreenPublicImageUrl } from "../lib/server/01-lockscreen-images";

const DEITIES_FILE = "Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg";

export const metadata: Metadata = {
  title: "His Journey — Ask Śrīla Prabhupāda",
  description:
    "1965: at sixty-nine, Śrīla Prabhupāda crossed an ocean with a trunk of books. Five chapters — the Jaladuta, New York, Matchless Gifts, the books, the world.",
  alternates: { canonical: "/journey" },
};

export const dynamic = "force-static";

export default async function Journey() {
  const deitiesImageUrl = await getLockscreenPublicImageUrl(DEITIES_FILE);
  return <JourneyPage deitiesImageUrl={deitiesImageUrl} />;
}
