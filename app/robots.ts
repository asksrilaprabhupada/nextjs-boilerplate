/**
 * robots.ts — Robots.txt Generator
 *
 * Allows everything except the API and the /search result pages (noindex —
 * the curated pages carry the SEO). Origin follows NEXT_PUBLIC_SITE_URL.
 */
import { MetadataRoute } from "next";
import { SITE_URL } from "@/app/lib/20-site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/search"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
