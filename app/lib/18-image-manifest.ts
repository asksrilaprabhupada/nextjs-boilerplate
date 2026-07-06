/**
 * 18-image-manifest.ts — Photo manifest (single source for every image)
 *
 * Registry of every photograph under public/images/. The cinematic intro
 * rotates through INTRO_IMAGES (the dual-layer renderer never crops, so any
 * aspect ratio is welcome); the Moments gallery and page banners pick entries
 * by key. `allowFullBleed` marks sources large enough to stretch across the
 * viewport as a sharp cover background — the two 620×350 AVIFs and other small
 * scans must stay in card-width slots (or behind a deliberate blur backdrop).
 *
 * NOTE(owner): new photos dropped into public/images/lockscreen/ are
 * auto-served by /api/lockscreen-images, but must be registered HERE to join
 * the intro rotation and galleries. Add {src, alt, caption} below — captions
 * must describe what the photo actually shows.
 */

export interface ManifestImage {
  src: string;
  alt: string;
  /** Short truthful caption for gallery use. */
  caption: string;
  width?: number;
  height?: number;
  /** Large enough to render as a sharp full-viewport cover background. */
  allowFullBleed: boolean;
}

export const IMAGE_MANIFEST: ManifestImage[] = [
  {
    src: "/images/lockscreen/prabhupadaanddisciplessmiling.jpg",
    alt: "Śrīla Prabhupāda smiling among his disciples",
    caption: "With his disciples",
    width: 2682,
    height: 1875,
    allowFullBleed: true,
  },
  {
    src: "/images/lockscreen/Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg",
    alt: "Śrīla Prabhupāda before the Kṛṣṇa-Balarāma Deities in Vṛndāvana",
    caption: "Before the Kṛṣṇa-Balarāma Deities",
    allowFullBleed: false,
  },
  {
    src: "/images/lockscreen/Srila-Prabhupada-on-morning-walk-in-Vrindavan-620x350.avif",
    alt: "Śrīla Prabhupāda on a morning walk in Vṛndāvana",
    caption: "Morning walk in Vṛndāvana",
    width: 620,
    height: 350,
    allowFullBleed: false, // 620px source — card-width slots only
  },
  {
    src: "/images/lockscreen/Prabh14.jpg",
    alt: "Śrīla Prabhupāda — archival photograph",
    caption: "Śrīla Prabhupāda",
    width: 682,
    height: 466,
    allowFullBleed: false,
  },
  {
    src: "/images/lockscreen/CT03-044-620x350.avif",
    alt: "Śrīla Prabhupāda — archival photograph",
    caption: "Śrīla Prabhupāda — archival photograph",
    width: 620,
    height: 350,
    allowFullBleed: false, // 620px source — card-width slots only
  },
];

/** The intro's dual-layer renderer never crops, so every photo qualifies. */
export const INTRO_IMAGES = IMAGE_MANIFEST;

/** Quick lookup by src basename-ish key for page slots. */
export const IMG = {
  disciples: IMAGE_MANIFEST[0],
  deities: IMAGE_MANIFEST[1],
  walk: IMAGE_MANIFEST[2],
  prabhupada: IMAGE_MANIFEST[3],
  archival: IMAGE_MANIFEST[4],
} as const;
