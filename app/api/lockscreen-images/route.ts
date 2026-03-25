/**
 * route.ts — Lockscreen Images API Route
 *
 * Returns the list of slideshow images from the public/images/lockscreen directory.
 * Provides the lock screen with its dynamic image list.
 */
import { NextResponse } from "next/server";
import { getLockscreenSlideshowImages } from "@/app/lib/server/01-lockscreen-images";

export async function GET() {
  const images = await getLockscreenSlideshowImages();
  return NextResponse.json({ images });
}
