/**
 * route.ts — Lockscreen Images API Route
 *
 * Publishes the validated slideshow list generated once during each deployment.
 * A new deployment refreshes the list after files are added or removed.
 */
import { NextResponse } from "next/server";
import { getLockscreenSlideshowImages } from "@/app/lib/server/01-lockscreen-images";

export const dynamic = "force-static";

export async function GET() {
  const images = await getLockscreenSlideshowImages();
  return NextResponse.json({ images });
}
