/**
 * 01-lockscreen-images.ts — validated server-side lock-screen photo discovery.
 *
 * The public folder is the source of truth. Every non-placeholder file is
 * inspected from its bytes during the build, so a bad upload fails with its
 * exact filename instead of silently disappearing from the doorway.
 */
import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { KEN_BURNS_DIRECTIONS, type SlideImage } from "../06-lockscreen-data";

const LOCKSCREEN_PUBLIC_DIR = path.join(process.cwd(), "public", "images", "lockscreen");
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_DECODER_BRANDS = new Set(["mif1", "msf1", "heic", "heix", "hevc", "hevx"]);
const HEIC_DECODE_NATIVE_BRANDS = new Set(["mif1", "msf1", "heic", "heix", "hevc", "hevx"]);
const MAX_FTYP_SEARCH_BYTES = 4096;
// Bump this whenever the decoder, orientation handling, or JPEG settings change.
const LOCKSCREEN_CONVERSION_REVISION = "jpeg-v1";

export type LockscreenImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "heic";

export interface DiscoveredLockscreenImage {
  fileName: string;
  ext: string;
  actualFormat: LockscreenImageFormat;
  requiresConversion: boolean;
  sha256: string;
  width: number;
  height: number;
}

export class LockscreenImageValidationError extends Error {
  readonly fileName: string;

  constructor(fileName: string, reason: string) {
    super(`Lockscreen image "${fileName}" is unsupported or corrupt: ${reason}`);
    this.name = "LockscreenImageValidationError";
    this.fileName = fileName;
  }
}

function compareFileNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]
  ) >>> 0;
}

function fourCharacterCode(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Detects HEIC/HEVC and AVIF from the ISO-BMFF `ftyp` box, never the filename. */
export function detectedIsoBmffImageFormat(bytes: Uint8Array): "heic" | "avif" | null {
  let offset = 0;

  while (offset + 8 <= bytes.byteLength && offset < MAX_FTYP_SEARCH_BYTES) {
    const size32 = uint32BigEndian(bytes, offset);
    const boxType = fourCharacterCode(bytes, offset + 4);
    let headerSize = 8;
    let boxSize = size32;

    if (size32 === 1) {
      if (offset + 16 > bytes.byteLength) return null;
      const high = uint32BigEndian(bytes, offset + 8);
      const low = uint32BigEndian(bytes, offset + 12);
      if (high > 0x1fffff) return null;
      boxSize = (high * 0x100000000) + low;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = bytes.byteLength - offset;
    }

    if (boxSize < headerSize || offset + boxSize > bytes.byteLength) return null;

    if (boxType === "ftyp") {
      if (boxSize < headerSize + 8) return null;
      const majorBrand = fourCharacterCode(bytes, offset + headerSize);
      const compatibleBrands: string[] = [];
      for (let brandOffset = offset + headerSize + 8; brandOffset + 4 <= offset + boxSize; brandOffset += 4) {
        compatibleBrands.push(fourCharacterCode(bytes, brandOffset));
      }

      const brands = [majorBrand, ...compatibleBrands];
      // AVIF wins if a malformed or generic file advertises both codec families.
      if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "avif";
      if (brands.some((brand) => HEIC_DECODER_BRANDS.has(brand))) return "heic";
      return null;
    }

    if (boxSize === 0) return null;
    offset += boxSize;
  }

  return null;
}

interface DecodedHeicPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function decodeHeicPixels(bytes: Buffer): Promise<DecodedHeicPixels> {
  const { default: decodeHeic } = await import("heic-decode");
  let decoderBytes = bytes;
  // heic-decode 2.1 checks only the major brand before handing bytes to
  // libheif. A file may instead declare HEIC as a compatible brand, so present
  // a generic mif1 major brand to that guard without changing the image payload.
  if (bytes.byteLength >= 12 && fourCharacterCode(bytes, 4) === "ftyp") {
    const majorBrand = fourCharacterCode(bytes, 8);
    if (!HEIC_DECODE_NATIVE_BRANDS.has(majorBrand)) {
      decoderBytes = Buffer.from(bytes);
      decoderBytes.write("mif1", 8, 4, "ascii");
    }
  }

  const decoded = await decodeHeic({ buffer: decoderBytes });
  const { width, height, data } = decoded;
  const expectedBytes = width * height * 4;

  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || !Number.isSafeInteger(expectedBytes)
    || data.byteLength !== expectedBytes) {
    throw new Error("HEIC decoder returned invalid RGBA pixels");
  }

  return decoded;
}

export function detectedLockscreenFormat(metadata: Pick<Metadata, "format" | "compression">): LockscreenImageFormat | null {
  switch (metadata.format) {
    case "jpeg":
    case "png":
    case "webp":
    case "gif":
      return metadata.format;
    case "heif":
      return metadata.compression === "av1" ? "avif" : "heic";
    default:
      return null;
  }
}

function extensionMatchesFormat(ext: string, actualFormat: LockscreenImageFormat): boolean {
  switch (actualFormat) {
    case "jpeg":
      return ext === ".jpg" || ext === ".jpeg";
    case "png":
      return ext === ".png";
    case "webp":
      return ext === ".webp";
    case "avif":
      return ext === ".avif";
    case "gif":
      return ext === ".gif";
    case "heic":
      return ext === ".heic" || ext === ".heif";
  }
}

async function inspectLockscreenImage(fileName: string, absolutePath: string): Promise<DiscoveredLockscreenImage> {
  let bytes: Buffer;

  try {
    bytes = await fs.readFile(absolutePath);
  } catch {
    throw new LockscreenImageValidationError(fileName, "the image bytes could not be decoded");
  }

  const isoBmffFormat = detectedIsoBmffImageFormat(bytes);
  if (isoBmffFormat === "heic") {
    try {
      const decoded = await decodeHeicPixels(bytes);
      const ext = path.extname(fileName).toLowerCase();
      return {
        fileName,
        ext,
        actualFormat: "heic",
        requiresConversion: true,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: decoded.width,
        height: decoded.height,
      };
    } catch {
      throw new LockscreenImageValidationError(fileName, "the HEIC/HEVC bytes could not be decoded");
    }
  }

  let metadata: Metadata;
  try {
    const image = sharp(bytes, { animated: true, failOn: "error" });
    metadata = await image.metadata();
    // metadata() proves the signature; stats() forces a complete pixel decode
    // so truncated files cannot pass the build-time check.
    await sharp(bytes, { animated: true, failOn: "error" }).stats();
  } catch {
    throw new LockscreenImageValidationError(fileName, "the image bytes could not be decoded");
  }

  const actualFormat = detectedLockscreenFormat(metadata);
  if (!actualFormat) {
    throw new LockscreenImageValidationError(fileName, `detected format ${metadata.format ?? "unknown"} is not supported`);
  }
  if (!metadata.width || !metadata.height) {
    throw new LockscreenImageValidationError(fileName, "width or height is missing");
  }

  const ext = path.extname(fileName).toLowerCase();
  return {
    fileName,
    ext,
    actualFormat,
    // HEIC/HEIF is not consistently browser-decodable. Any signature/extension
    // mismatch also goes through the same browser-safe JPEG conversion route.
    requiresConversion: actualFormat === "heic" || !extensionMatchesFormat(ext, actualFormat),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: metadata.width,
    height: metadata.height,
  };
}

export async function discoverLockscreenImages(
  directory: string = LOCKSCREEN_PUBLIC_DIR,
): Promise<DiscoveredLockscreenImage[]> {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const fileNames = entries
    .filter((entry) => (
      entry.isFile()
      && !entry.name.startsWith(".")
    ))
    .map((entry) => entry.name)
    .sort(compareFileNames);

  const discovered: DiscoveredLockscreenImage[] = [];
  for (const fileName of fileNames) {
    discovered.push(await inspectLockscreenImage(fileName, path.join(directory, fileName)));
  }
  return discovered;
}

function publicImageUrl(image: DiscoveredLockscreenImage): string {
  if (image.requiresConversion) {
    const version = lockscreenConversionDigest(image.sha256).slice(0, 16);
    const query = new URLSearchParams({ file: image.fileName, v: version });
    return `/api/lockscreen-images/heic?${query.toString()}`;
  }
  const version = image.sha256.slice(0, 16);
  return `/images/lockscreen/${encodeURIComponent(image.fileName)}?v=${version}`;
}

/** Content identity for the normalized JPEG, including the conversion recipe. */
export function lockscreenConversionDigest(sourceSha256: string): string {
  return createHash("sha256")
    .update(LOCKSCREEN_CONVERSION_REVISION)
    .update("\0")
    .update(sourceSha256)
    .digest("hex");
}

/** Returns the validated, content-versioned URL for one named lock-screen file. */
export async function getLockscreenPublicImageUrl(fileName: string): Promise<string | null> {
  if (!isSafeLockscreenFileName(fileName)) return null;
  const absolutePath = path.join(process.cwd(), "public", "images", "lockscreen", fileName);

  try {
    const fileStat = await fs.lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    return publicImageUrl(await inspectLockscreenImage(fileName, absolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function getLockscreenSlideshowImages(
  directory: string = LOCKSCREEN_PUBLIC_DIR,
): Promise<SlideImage[]> {
  const discovered = await discoverLockscreenImages(directory);
  const usableImages = discovered.map((image, index): SlideImage => ({
    url: publicImageUrl(image),
    alt: `Lock screen photograph ${index + 1}`,
    kenBurnsDirection: KEN_BURNS_DIRECTIONS[index % KEN_BURNS_DIRECTIONS.length],
  }));

  return usableImages;
}

export function getLockscreenImagePath(
  fileName: string,
  directory: string = LOCKSCREEN_PUBLIC_DIR,
): string | null {
  if (!isSafeLockscreenFileName(fileName)) return null;

  const root = path.resolve(directory);
  const candidate = path.resolve(root, fileName);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return candidate;
}

function isSafeLockscreenFileName(fileName: string): boolean {
  if (!fileName || fileName.startsWith(".") || fileName.includes("\0")) return false;
  return path.basename(fileName) === fileName && !fileName.includes("/") && !fileName.includes("\\");
}

export async function getLockscreenImageForConversion(
  fileName: string,
): Promise<{ bytes: Buffer; sha256: string } | null> {
  if (!isSafeLockscreenFileName(fileName)) return null;
  // Keep this path statically scoped so Next/Vercel traces only the lockscreen
  // folder into the server function instead of sweeping the whole repository.
  const absolutePath = path.join(process.cwd(), "public", "images", "lockscreen", fileName);

  try {
    const fileStat = await fs.lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    const bytes = await fs.readFile(absolutePath);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

/** Converts without resize, extraction, or crop; source dimensions are kept. */
export async function convertLockscreenImageToJpeg(bytes: Buffer): Promise<Buffer> {
  if (detectedIsoBmffImageFormat(bytes) === "heic") {
    const decoded = await decodeHeicPixels(bytes);
    return sharp(Buffer.from(decoded.data), {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
      failOn: "error",
    }).jpeg({ quality: 90 }).toBuffer();
  }
  return sharp(bytes, { failOn: "error" }).autoOrient().jpeg({ quality: 90 }).toBuffer();
}
