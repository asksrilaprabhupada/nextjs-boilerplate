/**
 * 01-page-overlay.tsx — Page Overlay Wrapper
 *
 * Reusable modal wrapper with Framer Motion animations for slide-in overlays.
 * Provides the consistent backdrop and animation for all modal dialogs in the app.
 */
"use client";

import { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface PageOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export default function PageOverlay({ isOpen, onClose, children }: PageOverlayProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            background: "color-mix(in srgb, var(--ink-strong) 20%, transparent)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 560,
              maxHeight: "85vh",
              overflowY: "auto",
              background: "var(--surface-raised)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              borderRadius: "clamp(16px, 3vw, 22px)",
              padding: "clamp(20px, 5vw, 40px)",
              boxShadow: "0 24px 80px color-mix(in srgb, var(--accent) 12%, transparent), 0 8px 32px color-mix(in srgb, var(--ink-strong) 6%, transparent)",
              border: "1px solid var(--border-hair)",
              position: "relative",
            }}
          >
            {/* Close button */}
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                width: 40,
                height: 40,
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--accent-tint) 25%, transparent)",
                background: "color-mix(in srgb, var(--surface-raised) 60%, transparent)",
                color: "var(--ink-muted)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1rem",
                transition: "all 0.3s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 8%, transparent)";
                e.currentTarget.style.color = "var(--ink)";
                e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 20%, transparent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "color-mix(in srgb, var(--surface-raised) 60%, transparent)";
                e.currentTarget.style.color = "var(--ink-muted)";
                e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent-tint) 25%, transparent)";
              }}
            >
              ✕
            </button>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
