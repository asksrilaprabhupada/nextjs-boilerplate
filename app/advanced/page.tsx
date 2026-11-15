/**
 * advanced/page.tsx — Advanced (the previous ācāryas' books), switched off
 *
 * Answers 404 unless the deployment sets NEXT_PUBLIC_ADVANCED_ENABLED="true".
 * The ācāryas' books are not in the database yet; even when switched on, the
 * page shows the chooser and says honestly that there is nothing to search.
 * Never indexed.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AdvancedPage from "../components/cinematic/20-advanced-page";
import { ADVANCED_ENABLED } from "../lib/28-advanced-flag";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Advanced — Ask Śrīla Prabhupāda",
  robots: { index: false, follow: false },
};

export default async function Advanced({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  if (!ADVANCED_ENABLED) notFound();
  const { q } = await searchParams;
  return <AdvancedPage q={(q || "").trim().slice(0, 500)} />;
}
