/**
 * 20-site.ts — Canonical site origin
 *
 * Single source for absolute URLs (metadataBase, OG/Twitter, sitemap, robots,
 * JSON-LD). Reads NEXT_PUBLIC_SITE_URL so the origin follows the deployment.
 *
 * TODO(owner): after attaching the custom domain in Vercel, set
 * NEXT_PUBLIC_SITE_URL=https://asksrilaprabhupada.com in the project's
 * environment variables — nothing else needs to change. Until then the
 * vercel.app origin below keeps OG/canonical URLs resolvable (the .com domain
 * is not attached to the project yet).
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://asksrilaprabhupada.vercel.app";
