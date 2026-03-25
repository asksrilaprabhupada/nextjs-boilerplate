/**
 * robots.ts — Robots.txt Generator
 *
 * Generates the robots.txt file for search engine crawlers.
 * Controls which pages search engines can index.
 */
import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/"],
      },
    ],
    sitemap: "https://asksrilaprabhupada.com/sitemap.xml",
  };
}