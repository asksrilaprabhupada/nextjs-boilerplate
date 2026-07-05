/**
 * 13-site-modals.tsx — Site-wide modal provider (Support the seva · Feature
 * request · Feedback)
 *
 * The three cinematic overlays, moved verbatim out of the home page monolith
 * so the unified header/footer can open them from ANY route. Mounted once in
 * app/layout.tsx; children call useSiteModals().openModal("donate" | "feature"
 * | "feedback"). Seva details come from app/lib/19-seva-config.ts. The feature
 * and feedback forms POST to /api/feedback (feedback table) with a success
 * state and an honest error state.
 */
"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SEVA } from "@/app/lib/19-seva-config";

export type SiteModal = "donate" | "feature" | "feedback" | null;

const SiteModalsContext = createContext<{ openModal: (m: Exclude<SiteModal, null>) => void }>({
  openModal: () => { /* provider not mounted */ },
});

export function useSiteModals() {
  return useContext(SiteModalsContext);
}

/* ── shared style fragments (ported from the home page overlays) ── */
const overlayBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center",
  padding: "clamp(20px,5vw,60px)",
  background: "radial-gradient(120% 100% at 50% 30%, rgba(45,36,80,0.42), rgba(22,18,12,0.66))",
  backdropFilter: "blur(16px) saturate(1.1)", WebkitBackdropFilter: "blur(16px) saturate(1.1)",
  animation: "moreOverlayIn 0.5s ease both",
};
const overlayPanel = (maxWidth: number): React.CSSProperties => ({
  position: "relative", width: "100%", maxWidth, maxHeight: "88vh", overflowY: "auto",
  padding: "clamp(30px,4vw,46px)", borderRadius: 28,
  background: "linear-gradient(160deg, rgba(254,252,248,0.98), rgba(250,247,241,0.96))",
  border: "1px solid rgba(255,255,255,0.6)",
  boxShadow: "0 40px 120px rgba(22,18,12,0.5), 0 0 0 1px rgba(107,87,201,0.08)",
  animation: "morePanelIn 0.7s cubic-bezier(0.16,1,0.3,1) both",
});
const eyebrow = (color: string): React.CSSProperties => ({
  fontSize: 11, fontWeight: 600, letterSpacing: "0.32em", textTransform: "uppercase", color, textAlign: "center",
});

export default function SiteModalsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [modal, setModal] = useState<SiteModal>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [featText, setFeatText] = useState("");
  const [featEmail, setFeatEmail] = useState("");
  const [featSent, setFeatSent] = useState(false);
  const [featSending, setFeatSending] = useState(false);
  const [featError, setFeatError] = useState<string | null>(null);

  const [fbVote, setFbVote] = useState<"up" | "down" | null>(null);
  const [fbText, setFbText] = useState("");
  const [fbSent, setFbSent] = useState(false);
  const [fbSending, setFbSending] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);

  const openModal = (m: Exclude<SiteModal, null>) => {
    setModal(m);
    setCopied(null);
    if (m === "feature") { setFeatSent(false); setFeatError(null); }
    if (m === "feedback") { setFbSent(false); setFbError(null); }
  };

  const copyRow = (label: string, value: string) => () => {
    try { navigator.clipboard.writeText(value); } catch { /* ok */ }
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1600);
  };

  /** POST to the feedback table via the existing route handler. */
  const submitToFeedback = async (payload: { type: "feature" | "feedback"; message: string; email?: string }) => {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: payload.type,
        message: payload.message,
        email: payload.email || null,
        page_url: pathname,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };

  const sendFeature = async () => {
    if (!featText.trim() || featSending) return;
    setFeatSending(true);
    setFeatError(null);
    try {
      await submitToFeedback({ type: "feature", message: featText.trim(), email: featEmail.trim() || undefined });
      setFeatSent(true);
    } catch {
      setFeatError("Couldn't send just now — please try again.");
    } finally {
      setFeatSending(false);
    }
  };

  const sendFeedback = async () => {
    if ((!fbVote && !fbText.trim()) || fbSending) return;
    setFbSending(true);
    setFbError(null);
    try {
      const message = [fbVote ? `[${fbVote === "up" ? "helpful" : "could be better"}]` : "", fbText.trim()].filter(Boolean).join(" ");
      await submitToFeedback({ type: "feedback", message });
      setFbSent(true);
    } catch {
      setFbError("Couldn't send just now — please try again.");
    } finally {
      setFbSending(false);
    }
  };

  const featDisabled = !featText.trim() || featSending;
  const fbDisabled = (!fbVote && !fbText.trim()) || fbSending;

  const closeBtn = (
    <button onClick={() => setModal(null)} aria-label="Close" className="cine-close"
      style={{ position: "absolute", top: 16, right: 16, width: 38, height: 38, borderRadius: "50%", border: "1px solid #E8E0D2", background: "rgba(254,252,248,0.9)", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  );

  return (
    <SiteModalsContext.Provider value={{ openModal }}>
      {children}

      {/* ═══════════ SUPPORT THE SEVA — cinematic overlay ═══════════ */}
      {modal === "donate" && (
        <div role="dialog" aria-label="Support the seva" onClick={() => setModal(null)} style={overlayBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={overlayPanel(520)}>
            {closeBtn}
            <p className="font-body" style={eyebrow("#C9A24B")}>Support the seva</p>
            <h2 className="font-display" style={{ fontSize: "clamp(24px,3vw,34px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>Keep his words freely searchable</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,18px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: 24 }}>No ads. No fees. Only seva.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {SEVA.rows.map((d, i) => (
                <div key={d.label} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", padding: "12px 16px", border: "1px solid #E8E0D2", borderRadius: 14, background: "rgba(254,252,248,0.9)", opacity: 0, animation: "moreCardIn 0.55s cubic-bezier(0.16,1,0.3,1) both", animationDelay: `${(0.14 + i * 0.06).toFixed(2)}s` }}>
                  <div style={{ minWidth: 0 }}>
                    <p className="font-body" style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.22em", textTransform: "uppercase", color: "#C9A24B" }}>{d.label}</p>
                    <p className="font-body" style={{ fontSize: 15, fontWeight: 500, color: "#2B2519", marginTop: 3, fontVariantNumeric: "tabular-nums", overflowWrap: "break-word" }}>{d.value}</p>
                  </div>
                  <button onClick={copyRow(d.label, d.value)} className="cine-copy-btn font-body" style={{ padding: "7px 14px", borderRadius: 100, border: "1px solid rgba(107,87,201,0.3)", background: "rgba(107,87,201,0.06)", color: "#51409A", fontSize: 12, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.3s" }}>{copied === d.label ? "Copied" : "Copy"}</button>
                </div>
              ))}
            </div>
            <p className="font-body" style={{ fontSize: 12, color: "#9A8F7D", textAlign: "center", marginTop: 18 }}>Every contribution keeps the library online — servers, search, nothing else.</p>
          </div>
        </div>
      )}

      {/* ═══════════ FEATURE REQUEST — cinematic overlay ═══════════ */}
      {modal === "feature" && (
        <div role="dialog" aria-label="Feature request" onClick={() => setModal(null)} style={overlayBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={overlayPanel(520)}>
            {closeBtn}
            <p className="font-body" style={eyebrow("#C9A24B")}>Shape what comes next</p>
            <h2 className="font-display" style={{ fontSize: "clamp(24px,3vw,34px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>What would serve your study?</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,18px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: 24 }}>Describe it — we read every request.</p>
            {!featSent ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.15s both" }}>
                <textarea value={featText} onChange={(e) => setFeatText(e.target.value)} placeholder="The feature you wish existed…" rows={4} aria-label="Feature request" className="cine-field font-body" style={{ width: "100%", display: "block", padding: "14px 16px", fontSize: 14, border: "1px solid #E8E0D2", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none", resize: "none", lineHeight: 1.6, transition: "border-color 0.3s" }} />
                <input value={featEmail} onChange={(e) => setFeatEmail(e.target.value)} placeholder="Email (optional — for updates)" aria-label="Email" className="cine-field font-body" style={{ width: "100%", display: "block", padding: "13px 16px", fontSize: 14, border: "1px solid #E8E0D2", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none", transition: "border-color 0.3s" }} />
                {featError && <p className="font-body" role="alert" style={{ fontSize: 13, color: "#A4552E", textAlign: "center", margin: 0 }}>{featError}</p>}
                <button onClick={sendFeature} disabled={featDisabled} className="cine-send-btn font-body" style={{ alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 9, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", borderRadius: 100, padding: "13px 34px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", cursor: featDisabled ? "default" : "pointer", opacity: featDisabled ? 0.45 : 1, boxShadow: "0 10px 30px rgba(107,87,201,0.3)", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)", marginTop: 6 }}>{featSending ? "Sending…" : "Send request"}</button>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "18px 0 6px", animation: "moreCardIn 0.7s cubic-bezier(0.16,1,0.3,1) both" }}>
                <div aria-hidden style={{ width: 56, height: 1, background: "linear-gradient(90deg, transparent, #C9A24B, transparent)", margin: "0 auto 18px" }} />
                <p className="font-display" style={{ fontSize: 24, fontStyle: "italic", color: "#201B12" }}>Received — thank you.</p>
                <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 8 }}>Every request is read. Hare Kṛṣṇa.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ FEEDBACK — cinematic overlay ═══════════ */}
      {modal === "feedback" && (
        <div role="dialog" aria-label="Feedback" onClick={() => setModal(null)} style={overlayBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={overlayPanel(520)}>
            {closeBtn}
            <p className="font-body" style={eyebrow("#C9A24B")}>From the heart</p>
            <h2 className="font-display" style={{ fontSize: "clamp(24px,3vw,34px)", fontWeight: 600, letterSpacing: "-0.02em", color: "#201B12", textAlign: "center", margin: "8px 0 4px" }}>How was your experience?</h2>
            <p className="font-display" style={{ fontSize: "clamp(15px,1.8vw,18px)", fontStyle: "italic", color: "#6E6353", textAlign: "center", marginBottom: 24 }}>Your words guide ours.</p>
            {!fbSent ? (
              <>
                <div style={{ display: "flex", justifyContent: "center", gap: 12, opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.12s both" }}>
                  <button onClick={() => setFbVote("up")} className="cine-vote-btn font-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 140, padding: "18px 12px", borderRadius: 18, border: `1px solid ${fbVote === "up" ? "#6B57C9" : "#E8E0D2"}`, background: fbVote === "up" ? "rgba(107,87,201,0.10)" : "rgba(254,252,248,0.9)", color: fbVote === "up" ? "#51409A" : "#6E6353", cursor: "pointer", fontSize: 13, fontWeight: 500, transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)" }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /></svg>
                    <span>Helpful</span>
                  </button>
                  <button onClick={() => setFbVote("down")} className="cine-vote-btn font-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 140, padding: "18px 12px", borderRadius: 18, border: `1px solid ${fbVote === "down" ? "#6B57C9" : "#E8E0D2"}`, background: fbVote === "down" ? "rgba(107,87,201,0.10)" : "rgba(254,252,248,0.9)", color: fbVote === "down" ? "#51409A" : "#6E6353", cursor: "pointer", fontSize: 13, fontWeight: 500, transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)" }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" /></svg>
                    <span>Could be better</span>
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14, opacity: 0, animation: "moreCardIn 0.6s cubic-bezier(0.16,1,0.3,1) 0.2s both" }}>
                  <textarea value={fbText} onChange={(e) => setFbText(e.target.value)} placeholder="Tell us more (optional)…" rows={3} aria-label="Feedback" className="cine-field font-body" style={{ width: "100%", display: "block", padding: "14px 16px", fontSize: 14, border: "1px solid #E8E0D2", borderRadius: 14, background: "#FEFCF8", color: "#2B2519", outline: "none", resize: "none", lineHeight: 1.6, transition: "border-color 0.3s" }} />
                  {fbError && <p className="font-body" role="alert" style={{ fontSize: 13, color: "#A4552E", textAlign: "center", margin: 0 }}>{fbError}</p>}
                  <button onClick={sendFeedback} disabled={fbDisabled} className="cine-send-btn font-body" style={{ alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 9, background: "linear-gradient(135deg, #6B57C9, #51409A)", color: "#FFFFFF", border: "none", borderRadius: 100, padding: "13px 34px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em", cursor: fbDisabled ? "default" : "pointer", opacity: fbDisabled ? 0.45 : 1, boxShadow: "0 10px 30px rgba(107,87,201,0.3)", transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)" }}>{fbSending ? "Sending…" : "Send feedback"}</button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "18px 0 6px", animation: "moreCardIn 0.7s cubic-bezier(0.16,1,0.3,1) both" }}>
                <div aria-hidden style={{ width: 56, height: 1, background: "linear-gradient(90deg, transparent, #C9A24B, transparent)", margin: "0 auto 18px" }} />
                <p className="font-display" style={{ fontSize: 24, fontStyle: "italic", color: "#201B12" }}>Received — thank you.</p>
                <p className="font-body" style={{ fontSize: 13, color: "#9A8F7D", marginTop: 8 }}>Your words guide ours. Hare Kṛṣṇa.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </SiteModalsContext.Provider>
  );
}
