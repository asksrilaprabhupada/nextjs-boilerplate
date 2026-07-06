/**
 * sitemap.ts — Sitemap Generator
 *
 * Generates the XML sitemap for search engines: the four curated pages.
 * /search results are noindex (robots.ts also disallows them) — curated pages
 * carry the SEO. The origin follows NEXT_PUBLIC_SITE_URL (app/lib/20-site.ts).
 */
import { MetadataRoute } from "next";
import { SITE_URL } from "@/app/lib/20-site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/journey`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/features`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/how-it-works`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
  ];
}
