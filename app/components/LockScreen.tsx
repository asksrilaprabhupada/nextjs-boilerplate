"use client";

import { useState, useEffect, useCallback } from "react";
import { slideshowImages, lockscreenVideo, dailyVerses } from "../lib/lockscreen-data";

export default function LockScreen({ onDismiss }: { onDismiss: () => void }) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [nextImageIndex, setNextImageIndex] = useState(1);
  const [transitioning, setTransitioning] = useState(false);
  const [verse] = useState(() => dailyVerses[Math.floor(Math.random() * dailyVerses.length)]);
  const [visible, setVisible] = useState(true);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (lockscreenVideo) return; // skip slideshow if video is set
    const interval = setInterval(() => {
      setTransitioning(true);
      setTimeout(() => {
        setCurrentImageIndex((prev) => (prev + 1) % slideshowImages.length);
        setNextImageIndex((prev) => (prev + 1) % slideshowImages.length);
        setTransitioning(false);
      }, 1500);
    }, 9000);
    return () => clearInterval(interval);
  }, []);

  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setTimeout(onDismiss, 900);
  }, [onDismiss]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleDismiss();
      }
    },
    [handleDismiss]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const currentImage = slideshowImages[currentImageIndex];
  const nextImage = slideshowImages[nextImageIndex];

  const kenBurnsStyle = (direction: string) => {
    switch (direction) {
      case "zoom-in":
        return "kenBurnsZoomIn";
      case "pan-left":
        return "kenBurnsPanLeft";
      case "pan-right":
        return "kenBurnsPanRight";
      default:
        return "kenBurnsZoomIn";
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Click to enter Ask Śrīla Prabhupāda"
      onClick={handleDismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        cursor: "pointer",
        transform: visible ? "translateY(0)" : "translateY(-100%)",
        opacity: visible ? 1 : 0,
        transition: `transform 0.9s var(--ease-out-expo), opacity 0.6s ease`,
        overflow: "hidden",
      }}
    >
      {/* Video background (if set) */}
      {lockscreenVideo ? (
        <video
          autoPlay
          muted
          loop
          playsInline
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        >
          <source src={lockscreenVideo} type="video/mp4" />
        </video>
      ) : (
        <>
          {/* Photo slideshow background */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url(${currentImage.url})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              animation: `${kenBurnsStyle(currentImage.kenBurnsDirection)} 10s ease-in-out infinite alternate`,
              opacity: transitioning ? 0 : 1,
              transition: "opacity 1.5s ease",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: `url(${nextImage.url})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              animation: `${kenBurnsStyle(nextImage.kenBurnsDirection)} 10s ease-in-out infinite alternate`,
              opacity: transitioning ? 1 : 0,
              transition: "opacity 1.5s ease",
            }}
          />
        </>
      )}

      {/* Gradient overlay — light tinted for readability */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(to top, rgba(20,15,40,0.85) 0%, rgba(20,15,40,0.5) 30%, rgba(20,15,40,0.15) 60%, transparent 100%)`,
        }}
      />

      {/* Mandala decoration */}
      <svg
        viewBox="0 0 400 400"
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "min(80vw, 600px)",
          height: "min(80vw, 600px)",
          opacity: 0.04,
          animation: "rotate-mandala 120s linear infinite",
          pointerEvents: "none",
          color: "#fff",
        }}
      >
        {[...Array(12)].map((_, i) => (
          <g key={i} transform={`rotate(${i * 30} 200 200)`}>
            <ellipse cx="200" cy="120" rx="18" ry="40" fill="none" stroke="currentColor" strokeWidth="0.5" />
            <ellipse cx="200" cy="100" rx="10" ry="24" fill="none" stroke="currentColor" strokeWidth="0.3" />
          </g>
        ))}
        <circle cx="200" cy="200" r="60" fill="none" stroke="currentColor" strokeWidth="0.4" />
        <circle cx="200" cy="200" r="90" fill="none" stroke="currentColor" strokeWidth="0.3" />
        <circle cx="200" cy="200" r="130" fill="none" stroke="currentColor" strokeWidth="0.2" />
        <circle cx="200" cy="200" r="170" fill="none" stroke="currentColor" strokeWidth="0.15" />
      </svg>

      {/* Content */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingBottom: "clamp(60px, 12vh, 120px)",
          opacity: entered ? 1 : 0,
          transform: entered ? "translateY(0)" : "translateY(30px)",
          transition: "opacity 1.2s var(--ease-smooth), transform 1.2s var(--ease-smooth)",
        }}
      >
        {/* Verse */}
        <div
          className="font-cormorant"
          style={{
            fontSize: "clamp(1rem, 2.2vw, 1.35rem)",
            fontWeight: 400,
            fontStyle: "italic",
            color: "rgba(255,248,240,0.7)",
            maxWidth: 520,
            textAlign: "center",
            lineHeight: 1.7,
            padding: "0 24px",
          }}
        >
          &ldquo;{verse.text}&rdquo;
        </div>

        {/* Citation */}
        <div
          className="font-dm-sans"
          style={{
            fontSize: "0.82rem",
            color: "var(--saffron-glow)",
            opacity: 0.8,
            marginTop: 12,
          }}
        >
          — {verse.citation}
        </div>

        {/* CTA */}
        <div
          style={{
            marginTop: 48,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              border: "1px solid rgba(255,248,240,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              animation: "pulse-arrow 3s ease-in-out infinite",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ transform: "rotate(180deg)" }}>
              <path d="M8 12V4M4 8l4-4 4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span
            className="font-dm-sans"
            style={{
              fontSize: "0.68rem",
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "rgba(255,248,240,0.45)",
            }}
          >
            Click anywhere to enter
          </span>
        </div>
      </div>
    </div>
  );
}
