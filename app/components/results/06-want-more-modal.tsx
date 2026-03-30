/**
 * 06-want-more-modal.tsx — Want More Modal
 *
 * Full-screen modal showing all verses and prose from a selected book for the current query.
 * Lets users explore the complete set of relevant passages from a specific scripture.
 */
"use client";

import { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { BookGroup } from "./01-narrative-response";

interface Props {
  book: BookGroup;
  onClose: () => void;
}

function truncate(text: string, max: number) {
  if (!text || text.length <= max) return text || "";
  const cut = text.substring(0, max);
  const lp = cut.lastIndexOf(".");
  return lp > max * 0.5 ? cut.substring(0, lp + 1) : cut + "...";
}

export default function WantMoreModal({ book, onClose }: Props) {
  const handleKey = useCallback((e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }, [onClose]);
  useEffect(() => {
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", handleKey); };
  }, [handleKey]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(30,27,75,0.25)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          onClick={e => e.stopPropagation()}
          style={{ width: "100%", maxWidth: 720, maxHeight: "85vh", overflowY: "auto", background: "rgba(255,255,255,0.92)", backdropFilter: "blur(24px)", borderRadius: "clamp(16px, 3vw, 22px)", padding: "clamp(20px, 4vw, 32px) clamp(16px, 3.5vw, 28px)", boxShadow: "0 24px 80px rgba(139,92,246,0.15)", border: "1px solid rgba(255,255,255,0.7)", position: "relative" }}
        >
          {/* Close */}
          <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: 10, border: "1px solid rgba(196,181,253,0.25)", background: "rgba(255,255,255,0.6)", color: "#6B7280", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>✕</button>

          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#7C3AED", marginBottom: 4 }}>
              Complete References
            </p>
            <h2 className="font-display" style={{ fontSize: "1.4rem", fontWeight: 600, color: "#1E1B4B" }}>
              {book.name}
            </h2>
            <p className="font-body" style={{ fontSize: 13, color: "#6B7280", marginTop: 4 }}>
              {[
                book.verses.length > 0 && `${book.verses.length} verses`,
                book.prose.length > 0 && `${book.prose.length} prose passages`,
                (book.transcripts?.length || 0) > 0 && `${book.transcripts!.length} lecture passages`,
                (book.letters?.length || 0) > 0 && `${book.letters!.length} letter passages`,
              ].filter(Boolean).join(" · ")}
            </p>
          </div>

          {/* Verses */}
          {book.verses.map(v => {
            const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`;
            return (
              <div key={v.id} style={{ marginBottom: 16 }}>
                <div style={{ background: "rgba(245,240,255,0.5)", border: "1px solid rgba(196,181,253,0.25)", borderLeft: "3px solid #8B5CF6", padding: "16px 20px", borderRadius: 14 }}>
                  {v.sanskrit_devanagari && (
                    <p style={{ fontFamily: "'Noto Serif Devanagari', serif", fontSize: "0.95rem", lineHeight: 1.8, color: "#1E1B4B", marginBottom: 8 }}>{v.sanskrit_devanagari}</p>
                  )}
                  <p className="font-display" style={{ fontSize: "1rem", fontStyle: "italic", lineHeight: 1.7, color: "#1E1B4B" }}>
                    &ldquo;{v.translation}&rdquo;
                  </p>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                    <a href={v.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#8B5CF6", textDecoration: "none", fontWeight: 600 }}>
                      — {ref} ↗
                    </a>
                  </div>
                </div>
                {v.purport && (
                  <div style={{ marginTop: 6, background: "rgba(139,92,246,0.03)", border: "1px solid rgba(196,181,253,0.15)", borderLeft: "3px solid #7C3AED", padding: "14px 18px", borderRadius: 14 }}>
                    <p className="font-body" style={{ fontSize: 13, lineHeight: 1.8, color: "#374151" }}>{truncate(v.purport, 600)}</p>
                  </div>
                )}
              </div>
            );
          })}

          {/* Prose */}
          {book.prose.map(p => (
            <div key={p.id} style={{ marginBottom: 14, background: "rgba(245,240,255,0.3)", border: "1px solid rgba(196,181,253,0.15)", borderLeft: "3px solid #6366F1", padding: "14px 18px", borderRadius: 14 }}>
              {p.chapter_title && (
                <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B7280", marginBottom: 6 }}>{p.chapter_title}</p>
              )}
              <p className="font-body" style={{ fontSize: 14, lineHeight: 1.8, color: "#374151" }}>{truncate(p.body_text, 500)}</p>
              {p.vedabase_url && (
                <div style={{ textAlign: "right", marginTop: 6 }}>
                  <a href={p.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#6366F1", textDecoration: "none", fontWeight: 500 }}>
                    Read on Vedabase ↗
                  </a>
                </div>
              )}
            </div>
          ))}

          {/* Transcripts (Lectures) */}
          {(book.transcripts || []).map(t => {
            const datePart = t.date ? new Date(t.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
            const label = t.title || [datePart, t.location].filter(Boolean).join(" — ") || "Lecture";
            return (
              <div key={t.id} style={{ marginBottom: 14, background: "rgba(251,146,60,0.04)", border: "1px solid rgba(251,146,60,0.15)", borderLeft: "3px solid #FB923C", padding: "14px 18px", borderRadius: 14 }}>
                <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#C2410C", marginBottom: 6 }}>Lecture</p>
                <p className="font-body" style={{ fontSize: 12, color: "#666", marginBottom: 6, fontStyle: "italic" }}>{label}</p>
                <p className="font-body" style={{ fontSize: 14, lineHeight: 1.8, color: "#374151" }}>{truncate(t.body_text, 500)}</p>
                {t.vedabase_url && (
                  <div style={{ textAlign: "right", marginTop: 6 }}>
                    <a href={t.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#C2410C", textDecoration: "none", fontWeight: 500 }}>
                      Read on Vedabase ↗
                    </a>
                  </div>
                )}
              </div>
            );
          })}

          {/* Letters */}
          {(book.letters || []).map(l => {
            const datePart = l.date ? new Date(l.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
            const label = [l.recipient ? `To ${l.recipient}` : "", datePart].filter(Boolean).join(" — ") || "Letter";
            return (
              <div key={l.id} style={{ marginBottom: 14, background: "rgba(74,222,128,0.04)", border: "1px solid rgba(74,222,128,0.15)", borderLeft: "3px solid #4ADE80", padding: "14px 18px", borderRadius: 14 }}>
                <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#15803D", marginBottom: 6 }}>Letter</p>
                <p className="font-body" style={{ fontSize: 12, color: "#666", marginBottom: 6, fontStyle: "italic" }}>{label}</p>
                <p className="font-body" style={{ fontSize: 14, lineHeight: 1.8, color: "#374151" }}>{truncate(l.body_text, 500)}</p>
                {l.vedabase_url && (
                  <div style={{ textAlign: "right", marginTop: 6 }}>
                    <a href={l.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#15803D", textDecoration: "none", fontWeight: 500 }}>
                      Read on Vedabase ↗
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}