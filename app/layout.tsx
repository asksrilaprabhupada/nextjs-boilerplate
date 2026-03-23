import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda — Scripture Search",
  description:
    "A devotional knowledge engine grounded in Bhagavad Gītā, Śrīmad Bhāgavatam, and Caitanya Caritāmṛta. Every answer from Śrīla Prabhupāda's words.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* Garden Wash Background — Lavender Fields + Tulip Garden */}
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          {/* Garden gradient washes — wide horizontal bands like flower fields */}
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
          {/* Soft warm vignette — barely there, just a gentle edge warmth */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "radial-gradient(ellipse at 50% 30%, transparent 60%, rgba(245,240,255,0.4) 100%)",
            }}
          />
        </div>

        {/* Very subtle grain — almost invisible, just adds texture */}
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

        {/* Content */}
        <div style={{ position: "relative", zIndex: 2 }}>{children}</div>
      </body>
    </html>
  );
}
