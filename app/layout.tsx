/**
 * layout.tsx — Root Layout
 *
 * Defines the HTML shell, fonts (Cormorant Garamond, DM Sans, Noto Serif Devanagari), metadata, and background gradients.
 * Wraps every page with consistent styling and SEO configuration.
 */
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda — Search 27 Books of Vedic Wisdom",
  description:
    "AI-powered scripture search across all 27 books of Śrīla Prabhupāda — Bhagavad Gītā, Śrīmad Bhāgavatam, Caitanya Caritāmṛta, Nectar of Devotion, Kṛṣṇa Book, and more. 25,112 verses and 34,145 paragraphs. Every answer from Prabhupāda's actual words.",
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
    title: "Ask Śrīla Prabhupāda — Search 27 Books of Vedic Wisdom",
    description:
      "AI-powered scripture search engine. Ask any question and get answers directly from Śrīla Prabhupāda's books — 25,112 verses and 34,145 paragraphs across 27 books.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Ask Śrīla Prabhupāda — Scripture Search Engine",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ask Śrīla Prabhupāda — Search 27 Books of Vedic Wisdom",
    description:
      "AI-powered scripture search. Every answer from Prabhupāda's actual words across 27 books.",
    images: ["/og-image.png"],
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
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
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
                radial-gradient(ellipse 1200px 400px at 15% 10%, rgba(196,181,253,0.18), transparent),
                radial-gradient(ellipse 1000px 350px at 75% 8%, rgba(253,164,175,0.12), transparent),
                radial-gradient(ellipse 900px 500px at 50% 45%, rgba(196,181,253,0.10), transparent),
                radial-gradient(ellipse 800px 300px at 80% 60%, rgba(251,207,232,0.10), transparent),
                radial-gradient(ellipse 1100px 400px at 20% 75%, rgba(187,247,208,0.06), transparent),
                radial-gradient(ellipse 700px 350px at 60% 85%, rgba(253,230,138,0.06), transparent)
              `,
              animation: "gardenDrift 30s ease-in-out infinite",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(ellipse at 50% 30%, transparent 60%, rgba(245,240,255,0.4) 100%)",
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