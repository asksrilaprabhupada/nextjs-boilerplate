/**
 * manifest.ts — Web app manifest
 *
 * Gives "Add to Home Screen" the redesign's app icon: the gold face medallion
 * on a dark rounded square (docs/redesign/designs/Logo.dc.html). The PNGs are
 * made once by scripts/build-redesign-assets.py; the 16 px tab icon is the gold
 * book emblem in app/icon.svg, because a face cannot be read at 16 px.
 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ask Śrīla Prabhupāda",
    short_name: "Ask Prabhupāda",
    description: "Search Śrīla Prabhupāda's books, lectures and letters. Nothing added. Nothing invented.",
    start_url: "/",
    display: "standalone",
    background_color: "#16120c",
    theme_color: "#16120c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
