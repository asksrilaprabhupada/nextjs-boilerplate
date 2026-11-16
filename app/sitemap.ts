/**
 * sitemap.ts — Sitemap Generator
 *
 * Generates the XML sitemap for search engines: the home page only. His
 * Journey, Features and How it works are hidden for now (they redirect home,
 * see next.config.ts) and come back to the sitemap when the owner restores
 * them. /search results are noindex (robots.ts also disallows them). The
 * origin follows NEXT_PUBLIC_SITE_URL (app/lib/20-site.ts).
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
  ];
}
