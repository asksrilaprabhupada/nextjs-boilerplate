import { promises as fs } from "node:fs";
import path from "node:path";
import { KEN_BURNS_DIRECTIONS, lockscreenFallbackImage, type SlideImage } from "../lockscreen-data";

const LOCKSCREEN_PUBLIC_DIR = path.join(process.cwd(), "public", "images", "lockscreen");

export const DIRECT_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
export const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set([...DIRECT_IMAGE_EXTENSIONS, ...HEIC_EXTENSIONS]);

export interface DiscoveredLockscreenImage {
  fileName: string;
  ext: string;
  isHeicLike: boolean;
}

export async function discoverLockscreenImages(): Promise<DiscoveredLockscreenImage[]> {
  let entries: { isFile: () => boolean; name: string }[] = [];

  try {
    entries = await fs.readdir(LOCKSCREEN_PUBLIC_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name.startsWith(".")) return false;

      const ext = path.extname(entry.name).toLowerCase();
      return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
    })
    .map((entry) => {
      const ext = path.extname(entry.name).toLowerCase();
      return {
        fileName: entry.name,
        ext,
        isHeicLike: HEIC_EXTENSIONS.has(ext),
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function getLockscreenSlideshowImages(): Promise<SlideImage[]> {
  const discovered = await discoverLockscreenImages();

  const usableImages: SlideImage[] = discovered.map((image, index) => {
    const direction = KEN_BURNS_DIRECTIONS[index % KEN_BURNS_DIRECTIONS.length];
    const encodedFileName = encodeURIComponent(image.fileName);

    return {
      url: image.isHeicLike
        ? `/api/lockscreen-images/heic?file=${encodedFileName}`
        : `/images/lockscreen/${encodedFileName}`,
      alt: `Lock screen image ${index + 1}`,
      kenBurnsDirection: direction,
    };
  });

  return usableImages.length > 0 ? usableImages : [lockscreenFallbackImage];
}

export function getLockscreenImagePath(fileName: string): string | null {
  const normalized = path.basename(fileName);

  if (!normalized || normalized.startsWith(".")) {
    return null;
  }

  const ext = path.extname(normalized).toLowerCase();
  if (!HEIC_EXTENSIONS.has(ext)) {
    return null;
  }

  return path.join(LOCKSCREEN_PUBLIC_DIR, normalized);
}
