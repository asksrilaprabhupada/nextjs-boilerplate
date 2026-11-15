// next.config.ts — Next.js Configuration
// Defines build-time settings for the Next.js 16 App Router application.
//
// Redirects: His Journey, Features and How it works are hidden for now (the
// cinematic redesign, docs/redesign/HANDOFF.md §7). Their files are kept; the
// routes send visitors home with a TEMPORARY (307) redirect so they can come
// back later without browsers having cached a permanent move.
import type { NextConfig } from "next";

const HIDDEN_PAGES = ["/journey", "/features", "/how-it-works"];

const nextConfig: NextConfig = {
  async redirects() {
    return HIDDEN_PAGES.map((source) => ({
      source,
      destination: "/",
      permanent: false,
    }));
  },
};

export default nextConfig;
