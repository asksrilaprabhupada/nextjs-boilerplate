/**
 * 14-photo-slot.tsx — Path-addressed photo slot with honest placeholder
 *
 * Renders a photo frame bound to an EXACT public path (e.g.
 * /images/journey/journey-1965-jaladuta-ship.jpg). Until a real file exists at
 * that path, the slot shows a calm warm-paper placeholder with a truthful
 * "Photograph coming" caption; once the correctly named file is uploaded and
 * the site redeploys, the photo appears with no code change (onError → keep
 * placeholder, onLoad → fade the photo in). Also exports useImageAvailable()
 * for CSS-background slots that should prefer a path-addressed file and fall
 * back to an existing photo (journey interlude, landing 1965 banner).
 */
"use client";

import { useEffect, useRef, useState } from "react";

/**
 * True once `src` has successfully loaded in this browser. Always false during
 * SSR and the first client render, so server and client markup stay identical;
 * the probe also warms the cache, so a background-image swap paints instantly.
 */
export function useImageAvailable(src: string): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    const probe = new window.Image();
    probe.onload = () => {
      if (alive) setAvailable(true);
    };
    probe.src = src; // onerror ignored — the slot simply stays on its fallback
    return () => {
      alive = false;
    };
  }, [src]);
  return available;
}

type SlotStatus = "pending" | "loaded" | "missing";

interface PhotoSlotProps {
  /** Exact public path the maintainer will upload the photo to. */
  src: string;
  /** Honest description of the photo the named file will contain. */
  alt: string;
  /** Honest empty-state caption; doubles as the placeholder's aria-label. */
  placeholderCaption: string;
  /** Sizing only (width/maxWidth/height) — radius, shadow, overflow built in. */
  frame: React.CSSProperties;
  objectPosition?: string;
}

export default function PhotoSlot({ src, alt, placeholderCaption, frame, objectPosition = "center" }: PhotoSlotProps) {
  const [status, setStatus] = useState<SlotStatus>("pending");
  const imgRef = useRef<HTMLImageElement>(null);

  // Load/error can fire before hydration attaches handlers — settle from the
  // element's own state after mount.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete) setStatus(img.naturalWidth > 0 ? "loaded" : "missing");
  }, []);

  const loaded = status === "loaded";

  return (
    <div
      role={loaded ? undefined : "img"}
      aria-label={loaded ? undefined : placeholderCaption}
      style={{ position: "relative", overflow: "hidden", borderRadius: 18, boxShadow: "0 20px 60px rgba(43,37,25,0.14)", background: "#F1EBDF", ...frame }}
    >
      {!loaded && (
        <div aria-hidden style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, textAlign: "center", background: "linear-gradient(165deg, #F5F0E4, #EDE5D3)", boxShadow: "inset 0 0 0 1px #E8E0D2" }}>
          <div style={{ width: 40, height: 1, background: "#D8CCB8" }} />
          <p className="font-display" style={{ fontStyle: "italic", fontSize: "clamp(13px, 1.5vw, 15px)", color: "#9A8F7D", lineHeight: 1.6, maxWidth: "28ch" }}>{placeholderCaption}</p>
        </div>
      )}
      {status !== "missing" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={src}
          alt={loaded ? alt : ""}
          loading="lazy"
          decoding="async"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("missing")}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition, opacity: loaded ? 1 : 0, transition: "opacity 0.6s ease" }}
        />
      )}
    </div>
  );
}
