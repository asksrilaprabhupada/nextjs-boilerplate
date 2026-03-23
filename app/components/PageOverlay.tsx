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
            background: "rgba(30, 27, 75, 0.2)",
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
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 560,
              maxHeight: "80vh",
              overflowY: "auto",
              background: "rgba(255, 255, 255, 0.85)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              borderRadius: 22,
              padding: 40,
              boxShadow: "0 24px 80px rgba(139, 92, 246, 0.12), 0 8px 32px rgba(0,0,0,0.06)",
              border: "1px solid rgba(255, 255, 255, 0.7)",
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
                width: 36,
                height: 36,
                borderRadius: 10,
                border: "1px solid rgba(196, 181, 253, 0.25)",
                background: "rgba(255, 255, 255, 0.6)",
                color: "#9CA3AF",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1rem",
                transition: "all 0.3s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(139, 92, 246, 0.08)";
                e.currentTarget.style.color = "#1E1B4B";
                e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.6)";
                e.currentTarget.style.color = "#9CA3AF";
                e.currentTarget.style.borderColor = "rgba(196, 181, 253, 0.25)";
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
