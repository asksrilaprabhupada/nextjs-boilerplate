/**
 * layout.tsx — Root Layout
 *
 * Defines the HTML shell, fonts (Cormorant Garamond, DM Sans, Noto Serif Devanagari), metadata, and background gradients.
 * Wraps every page with consistent styling and SEO configuration.
 */
import type { Metadata } from "next";
import { Cormorant_Garamond, DM_Sans, Noto_Serif_Devanagari } from "next/font/google";
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
  title: "Ask Śrīla Prabhupāda — Search 36 Books, 3,700 Lectures & 6,500 Letters",
  description:
    "AI-powered search across 36 books, 3,700 lectures, and 6,500 letters of Śrīla Prabhupāda. 244,000 searchable passages from Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, recorded lectures, and personal letters. Every answer from Prabhupāda's actual words.",
  keywords: [
    "Srila Prabhupada", "Bhagavad Gita", "Srimad Bhagavatam", "Caitanya Caritamrita",
    "ISKCON", "Krishna", "Vedic", "scripture search", "purport", "devotional service",
    "Hare Krishna", "Vaishnava", "bhakti", "spiritual", "Nectar of Devotion",
  ],
  authors: [{ name: "Ask Śrīla Prabhupāda" }],
  creator: "Ask Śrīla Prabhupāda",
  metadataBase: new URL("https://asksrilaprabhupada.com"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://asksrilaprabhupada.com",
    siteName: "Ask Śrīla Prabhupāda",
    title: "Ask Śrīla Prabhupāda — Search 36 Books, 3,700 Lectures & 6,500 Letters",
    description:
      "AI-powered scripture search engine. Ask any question and get answers directly from Śrīla Prabhupāda's books, lectures, and letters — 244,000 searchable passages.",
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
    title: "Ask Śrīla Prabhupāda — Search 36 Books, 3,700 Lectures & 6,500 Letters",
    description:
      "AI-powered search across Prabhupāda's books, lectures, and letters. 244,000 passages. Every answer from his actual words.",
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
                radial-gradient(ellipse 1100px 460px at 22% 8%, color-mix(in srgb, var(--p-lavender) 12%, transparent), transparent),
                radial-gradient(ellipse 900px 420px at 80% 88%, color-mix(in srgb, var(--p-gold) 8%, transparent), transparent)
              `,
              animation: "gardenDrift 40s ease-in-out infinite",
            }}
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
            opacity: 0.03,
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

        <div style={{ position: "relative", zIndex: 2 }}>{children}</div>
      </body>
    </html>
  );
}