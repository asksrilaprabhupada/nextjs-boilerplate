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
        {/* Aurora Background Effect */}
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
                radial-gradient(ellipse 600px 400px at 25% 20%, rgba(139,92,246,0.15), transparent),
                radial-gradient(ellipse 500px 500px at 70% 15%, rgba(45,212,191,0.10), transparent),
                radial-gradient(ellipse 700px 350px at 50% 60%, rgba(217,70,239,0.08), transparent),
                radial-gradient(ellipse 400px 400px at 80% 70%, rgba(236,72,153,0.06), transparent),
                radial-gradient(ellipse 500px 300px at 15% 80%, rgba(99,102,241,0.08), transparent)
              `,
              animation: "auroraShift 25s ease-in-out infinite",
            }}
          />
          {/* Vignette overlay */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "radial-gradient(ellipse at 50% 0%, transparent 50%, #0F0E1A 100%)",
            }}
          />
        </div>

        {/* Grain Texture Overlay */}
        <svg
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 1,
            opacity: 0.32,
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
