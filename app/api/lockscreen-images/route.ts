import { NextResponse } from "next/server";
import { getLockscreenSlideshowImages } from "@/app/lib/server/lockscreen-images";

export async function GET() {
  const images = await getLockscreenSlideshowImages();
  return NextResponse.json({ images });
}
