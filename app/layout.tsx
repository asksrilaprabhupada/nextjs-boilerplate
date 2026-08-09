/**
 * layout.tsx — Root Layout
 *
 * Defines the HTML shell, fonts (Cormorant Garamond, DM Sans, Noto Serif Devanagari), metadata, and background gradients.
 * Wraps every page with consistent styling and SEO configuration.
 */
import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, DM_Sans, Noto_Serif_Devanagari } from "next/font/google";
import SiteModalsProvider from "./components/cinematic/13-site-modals";
import { SITE_URL } from "@/app/lib/20-site";
import "./globals.css";

/*
 * Fonts are loaded via next/font (self-hosted, no render-blocking @import, no CLS).
 * Each exposes a CSS variable consumed by the .font-* classes in globals.css.
 * latin-ext covers IAST diacritics (ā, ṛ, ṣ, ṁ, ñ); devanagari covers Sanskrit.
 */
const fontDisplay = Cormorant_Garamond({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const fontBody = DM_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const fontDeva = Noto_Serif_Devanagari({
  subsets: ["devanagari", "latin"],
  weight: ["400", "500", "600"],
  variable: "--font-deva",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda — Search His Books, Lectures & Letters",
  description:
    "Search Śrīla Prabhupāda's 36 books, purports, 3,700 lectures, and 6,500 letters. Read his exact words with citations and Vedabase links. Nothing added, nothing invented.",
  keywords: [
    "Srila Prabhupada", "Bhagavad Gita", "Srimad Bhagavatam", "Caitanya Caritamrita",
    "ISKCON", "Krishna", "Vedic", "scripture search", "purport", "devotional service",
    "Hare Krishna", "Vaishnava", "bhakti", "spiritual", "Nectar of Devotion",
  ],
  authors: [{ name: "Ask Śrīla Prabhupāda" }],
  creator: "Ask Śrīla Prabhupāda",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Ask Śrīla Prabhupāda",
    title: "Ask Śrīla Prabhupāda — Search His Books, Lectures & Letters",
    description:
      "Ask any question and read the answer in Śrīla Prabhupāda's own words — 244,000 searchable passages from his books, lectures, and letters, every citation linked to Vedabase.",
    images: [
      {
        url: "/images/og-image.png",
        width: 1200,
        height: 630,
        alt: "Ask Śrīla Prabhupāda — Scripture Search Engine",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ask Śrīla Prabhupāda — Search His Books, Lectures & Letters",
    description:
      "Search Prabhupāda's books, lectures, and letters. 244,000 passages. Every answer in his actual words.",
    images: ["/images/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#FAF7F1",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fontDisplay.variable} ${fontBody.variable} ${fontDeva.variable}`}
    >
      <body>
        {/* Apply a saved warm-evening theme before paint (no flash). Defaults to light. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('theme')==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
        {/* Garden Wash Background */}
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: "-10%",
              background: `
                radial-gradient(ellipse 1100px 460px at 22% 8%, color-mix(in srgb, var(--p-lavender) 20%, transparent), transparent),
                radial-gradient(ellipse 900px 420px at 80% 88%, color-mix(in srgb, var(--p-gold) 14%, transparent), transparent),
                radial-gradient(ellipse 700px 380px at 55% 55%, color-mix(in srgb, var(--p-gold) 7%, transparent), transparent)
              `,
            }}
            className="garden-wash"
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(ellipse at 50% 30%, transparent 62%, color-mix(in srgb, var(--surface) 55%, transparent) 100%)",
            }}
          />
        </div>

        <svg
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 1,
            opacity: 0.05,
            pointerEvents: "none",
          }}
        >
          <filter id="grain">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.85"
              numOctaves="4"
              stitchTiles="stitch"
            />
          </filter>
          <rect width="100%" height="100%" filter="url(#grain)" />
        </svg>

        {/* Structured data: the site + its search action, and the organization. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                name: "Ask Śrīla Prabhupāda",
                url: SITE_URL,
                potentialAction: {
                  "@type": "SearchAction",
                  target: {
                    "@type": "EntryPoint",
                    urlTemplate: `${SITE_URL}/search?q={search_term_string}`,
                  },
                  "query-input": "required name=search_term_string",
                },
              },
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "Ask Śrīla Prabhupāda",
                url: SITE_URL,
                logo: `${SITE_URL}/images/og-image.png`,
              },
            ]),
          }}
        />

        <div style={{ position: "relative", zIndex: 2 }}>
          <SiteModalsProvider>{children}</SiteModalsProvider>
        </div>
      </body>
    </html>
  );
}