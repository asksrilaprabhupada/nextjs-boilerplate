/**
 * 02-scroll-top-button.tsx — Scroll to Top Button
 *
 * Renders a floating upward-arrow button in the bottom-right corner (above the feedback button).
 * Appears when the user scrolls down, with a continuous gentle bounce animation.
 * Clicking it smooth-scrolls the page back to the top.
 */
"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

export default function ScrollTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => setVisible(window.scrollY > 300);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          key="scroll-top"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.25 }}
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="Scroll to top"
          style={{
            position: "fixed",
            bottom: 72,
            right: 16,
            zIndex: 89,
            width: 40,
            height: 40,
            borderRadius: 12,
            border: "none",
            cursor: "pointer",
            background: "linear-gradient(135deg, #8B5CF6, #7C3AED)",
            boxShadow: "0 6px 20px rgba(139,92,246,0.30)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
          }}
        >
          <motion.svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            animate={{ y: [0, -4, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          >
            <path d="M18 15l-6-6-6 6" />
          </motion.svg>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
