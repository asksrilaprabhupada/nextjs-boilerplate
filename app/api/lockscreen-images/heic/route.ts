/**
 * route.ts — HEIC Image Conversion Route
 *
 * Converts HEIC/HEIF and extension-mismatched images to browser-safe JPEG.
 * HEIC/HEVC uses the bundled JavaScript/WebAssembly decoder; pixel dimensions
 * are retained with no resize, extraction, or crop.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  convertLockscreenImageToJpeg,
  getLockscreenImageForConversion,
  lockscreenConversionDigest,
} from "@/app/lib/server/01-lockscreen-images";

export async function GET(request: NextRequest) {
  const fileName = request.nextUrl.searchParams.get("file");
  if (!fileName) {
    return new NextResponse("Missing file query parameter", { status: 400 });
  }

  const source = await getLockscreenImageForConversion(fileName);
  if (!source) {
    return new NextResponse("Unsupported file", { status: 400 });
  }

  const requestedVersion = request.nextUrl.searchParams.get("v");
  const conversionDigest = lockscreenConversionDigest(source.sha256);
  const currentVersion = conversionDigest.slice(0, 16);
  if (!requestedVersion) {
    return new NextResponse("Missing image version", { status: 400 });
  }
  if (requestedVersion !== currentVersion) {
    return new NextResponse("Image version not found", { status: 404 });
  }

  try {
    const outputBuffer = await convertLockscreenImageToJpeg(source.bytes);

    return new NextResponse(new Uint8Array(outputBuffer), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vercel-CDN-Cache-Control": "public, s-maxage=31536000, immutable",
        ETag: `"${conversionDigest}"`,
      },
    });
  } catch (error) {
    console.error("Failed to normalize lockscreen image", error);
    return new NextResponse("Failed to convert image", { status: 500 });
  }
}
