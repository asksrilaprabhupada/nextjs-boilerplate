/**
 * route.ts — HEIC Image Conversion Route
 *
 * Converts HEIC/HEIF images to JPEG format on-the-fly for browser compatibility.
 * Ensures Apple-format photos work as lockscreen slideshow images.
 */
import { promises as fs } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getLockscreenImagePath } from "@/app/lib/server/01-lockscreen-images";

export async function GET(request: NextRequest) {
  const fileName = request.nextUrl.searchParams.get("file");
  if (!fileName) {
    return new NextResponse("Missing file query parameter", { status: 400 });
  }

  const sourcePath = getLockscreenImagePath(fileName);
  if (!sourcePath) {
    return new NextResponse("Unsupported file", { status: 400 });
  }

  try {
    // Dynamic import — prevents Turbopack from crashing if the
    // sharp native binary is missing (it's an optional dep of next,
    // NOT a direct project dependency).
    const sharp = (await import("sharp")).default;

    const inputBuffer = await fs.readFile(sourcePath);
    const outputBuffer = await sharp(inputBuffer).jpeg({ quality: 90 }).toBuffer();

    return new NextResponse(new Uint8Array(outputBuffer), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Failed to convert HEIC/HEIF image", error);
    return new NextResponse("Failed to convert image", { status: 500 });
  }
}