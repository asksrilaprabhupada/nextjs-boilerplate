/**
 * 13-site-modals.tsx — Site-wide modal provider (Support the seva · Feature
 * request · Feedback)
 *
 * One cinematic shell — dark scrim, frosted gold-edged card, the same entrance
 * choreography as the rest of the site — with two contents:
 *
 *   • Support the seva — an India / International toggle revealing the labelled
 *     account rows from app/lib/19-seva-config.ts with tap-to-copy, plus GitHub
 *     star and share as secondary actions.
 *   • Feedback — one form for both "Request a feature" and "Send feedback":
 *     Bug / Idea / General pills (which retitle the placeholder and the submit
 *     button), optional name + email, and a gradient submit.
 *
 * Mounted once in app/layout.tsx; children call useSiteModals().openModal(
 * "donate" | "feature" | "feedback").
 *
 * Submitting composes a mail to FEEDBACK_EMAIL and hands off to the visitor's
 * email app — nothing is stored on this site. To post to the Supabase feedback
 * table instead, swap the body of `submitForm` for a POST to /api/feedback and
 * update the disclaimer line under the button.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { SEVA_REGIONS, SEVA_ROWS, SEVA_IS_PLACEHOLDER, type SevaRegion } from "@/app/lib/19-seva-config";

export type SiteModal = "donate" | "feature" | "feedback" | null;

/** TODO(owner): swap for the real inbox — this is where every form lands. */
const FEEDBACK_EMAIL = "hello@asksrilaprabhupada.org";
const GITHUB_URL = "https://github.com/asksrilaprabhupada/nextjs-boilerplate";

const SiteModalsContext = createContext<{ openModal: (m: Exclude<SiteModal, null>) => void }>({
  openModal: () => { /* provider not mounted */ },
});

export function useSiteModals() {
  return useContext(SiteModalsContext);
}

type Category = "bug" | "idea" | "general";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "bug", label: "Bug" },
  { key: "idea", label: "Idea" },
  { key: "general", label: "General" },
];

const PLACEHOLDER: Record<Category, string> = {
  bug: "What went wrong? Steps to reproduce help a lot…",
  idea: "I wish I could…",
  general: "Tell us what's working, and what isn't…",
};

const SUBMIT_LABEL: Record<Category, string> = {
  bug: "Send bug report",
  idea: "Send request",
  general: "Send feedback",
};

const CATEGORY_NAME: Record<Category, string> = {
  bug: "Bug report",
  idea: "Feature request",
  general: "General feedback",
};

/* ── style fragments (values from the v2 design) ── */
const scrim: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center",
  padding: "clamp(16px,4vw,40px)", background: "rgba(22,18,12,0.6)",
  backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
  animation: "moreOverlayIn 0.35s ease both",
};
const panel: React.CSSProperties = {
  position: "relative", width: "100%", maxWidth: 440, maxHeight: "88vh", overflowY: "auto",
  padding: "clamp(30px,4vw,42px) clamp(28px,4vw,38px) 32px", borderRadius: 24,
  background: "linear-gradient(165deg, #FEFCF8, #FAF7F1)",
  boxShadow: "0 30px 90px rgba(43,37,25,0.35), 0 0 0 1px rgba(201,162,75,0.14)",
  animation: "morePanelIn 0.45s cubic-bezier(0.16,1,0.3,1) both",
};
const pillTrack: React.CSSProperties = {
  display: "flex", gap: 4, padding: 4, background: "#F1EBDD", borderRadius: 100, marginBottom: 16,
};
const field: React.CSSProperties = {
  boxSizing: "border-box", width: "100%", padding: "11px 13px", borderRadius: 12,
  border: "1px solid #E8E0D2", background: "#fff", fontSize: 13.5, color: "#2B2519", outline: "none",
  transition: "border-color 0.25s",
};

export default function SiteModalsProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<SiteModal>(null);
  const [region, setRegion] = useState<SevaRegion>("india");
  const [copyHint, setCopyHint] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  const [category, setCategory] = useState<Category>("idea");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);

  const close = useCallback(() => setModal(null), []);

  const openModal = useCallback((m: Exclude<SiteModal, null>) => {
    setModal(m);
    setCopyHint("");
    if (m !== "donate") {
      setText("");
      setSent(false);
      setCategory(m === "feature" ? "idea" : "general");
    }
  }, []);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, close]);

  const copyRow = (label: string, value: string) => () => {
    if (!value) return;
    try { navigator.clipboard?.writeText(value); } catch { /* clipboard unavailable */ }
    setCopyHint(`${label} copied`);
    window.setTimeout(() => setCopyHint(""), 1800);
  };

  const shareLibrary = () => {
    const url = window.location.href;
    if (navigator.share) {
      navigator.share({ title: "Ask Śrīla Prabhupāda", url }).catch(() => { /* dismissed */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 2200);
      }).catch(() => { /* clipboard unavailable */ });
    }
  };

  const submitForm = () => {
    if (!text.trim()) return;
    const cat = CATEGORY_NAME[category];
    const subject = `[Ask Śrīla Prabhupāda] ${cat}${name ? ` from ${name}` : ""}`;
    const body = `Category: ${cat}\nName: ${name || "(not provided)"}\nEmail: ${email || "(not provided)"}\n\n${text}`;
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setSent(true);
  };

  const isSeva = modal === "donate";
  const isForm = modal === "feature" || modal === "feedback";
  const empty = !text.trim();
  const rows = SEVA_ROWS[region];

  return (
    <SiteModalsContext.Provider value={{ openModal }}>
      {children}

      {modal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={isSeva ? "Support the seva" : "Send feedback"}
          onClick={close}
          style={scrim}
        >
          <div onClick={(e) => e.stopPropagation()} style={panel}>
            <button onClick={close} aria-label="Close" className="cine-modal-close"
              style={{ position: "absolute", top: 16, right: 16, width: 34, height: 34, borderRadius: "50%", border: "1px solid #E8E0D2", background: "rgba(255,255,255,0.6)", color: "#6E6353", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.25s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>

            <p className="font-body" style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.28em", color: "#C9A24B", textTransform: "uppercase" }}>
              {isSeva ? "SEVA" : "FEEDBACK"}
            </p>
            <h3 className="font-display" style={{ margin: "0 0 14px", fontSize: 30, fontWeight: 600, color: "#201B12", letterSpacing: "-0.01em" }}>
              {isSeva ? "Support the seva" : "Send feedback"}
            </h3>
            <div aria-hidden style={{ width: 46, height: 1, background: "linear-gradient(90deg, #C9A24B, transparent)", margin: "0 0 18px" }} />
            <p className="font-body" style={{ margin: "0 0 24px", fontSize: 14.5, lineHeight: 1.6, color: "#5B5343" }}>
              {isSeva
                ? "This library is offered freely, as seva. If it has helped you, here is how to help it reach further."
                : "Bugs, ideas, or anything else on your mind — this goes straight to us."}
            </p>

            {/* ══ SUPPORT THE SEVA ══ */}
            {isSeva && (
              <div>
                <div style={pillTrack}>
                  {SEVA_REGIONS.map((r) => {
                    const on = region === r.key;
                    return (
                      <button key={r.key} onClick={() => setRegion(r.key)} className="font-body"
                        style={{ flex: 1, padding: "9px 14px", borderRadius: 100, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.3s", background: on ? "#FFFFFF" : "transparent", color: on ? "#51409A" : "#6E6353", boxShadow: on ? "0 2px 8px rgba(43,37,25,0.10)" : "none" }}>
                        {r.label}
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 14, overflow: "hidden", border: "1px solid #E8E0D2", marginBottom: 10 }}>
                  {rows.map((row) => (
                    <div key={row.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", background: "#FEFCF8" }}>
                      <div style={{ minWidth: 0 }}>
                        <p className="font-body" style={{ margin: 0, fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A8F7D" }}>{row.label}</p>
                        <p className="font-body" style={{ margin: "2px 0 0", fontSize: 13.5, color: row.value ? "#201B12" : "#B7AD9B", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {row.value || "Add in project"}
                        </p>
                      </div>
                      <button onClick={copyRow(row.label, row.value)} aria-label={`Copy ${row.label}`} disabled={!row.value} className="cine-row-copy"
                        style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 8, border: "1px solid #E8E0D2", background: "#fff", color: "#6E6353", cursor: row.value ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.25s" }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      </button>
                    </div>
                  ))}
                </div>

                <p className="font-body" style={{ margin: "0 0 18px", fontSize: 11, color: copyHint ? "#51409A" : "#9A8F7D", textAlign: "center", transition: "color 0.3s" }}>
                  {copyHint || (SEVA_IS_PLACEHOLDER ? "Tap a row to copy once real details are added." : "Tap a row to copy it.")}
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="cine-star-btn font-body"
                    style={{ textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 20px", borderRadius: 100, border: "1px solid #E8E0D2", background: "rgba(255,255,255,0.7)", color: "#2B2519", fontSize: 13.5, fontWeight: 500, transition: "all 0.3s" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.15-1.11-1.46-1.11-1.46-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.4 9.4 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" /></svg>
                    <span>Star the repository</span>
                  </a>
                  <button onClick={shareLibrary} className="cine-share-btn font-body"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 20px", borderRadius: 100, border: "none", background: "transparent", color: "#9A8F7D", fontSize: 13, fontWeight: 500, cursor: "pointer", transition: "color 0.3s" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" /></svg>
                    <span>{shareCopied ? "Link copied" : "Share with a devotee"}</span>
                  </button>
                </div>
              </div>
            )}

            {/* ══ FEEDBACK / FEATURE REQUEST ══ */}
            {isForm && (sent ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12, padding: "12px 0 4px", animation: "moreCardIn 0.5s cubic-bezier(0.16,1,0.3,1) both" }}>
                <div style={{ width: 46, height: 46, borderRadius: "50%", background: "linear-gradient(135deg, #6B57C9, #C9A24B)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </div>
                <p className="font-body" style={{ margin: 0, fontSize: 14.5, color: "#2B2519", lineHeight: 1.55, maxWidth: 300 }}>
                  Your email app should open with this ready to send — thank you for helping shape this.
                </p>
                <button onClick={() => { setText(""); setName(""); setEmail(""); setSent(false); }} className="font-body"
                  style={{ marginTop: 4, fontSize: 13, color: "#51409A", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Send another
                </button>
              </div>
            ) : (
              <div>
                <div style={pillTrack}>
                  {CATEGORIES.map((c) => {
                    const on = category === c.key;
                    return (
                      <button key={c.key} onClick={() => setCategory(c.key)} className="font-body"
                        style={{ flex: 1, padding: "8px 10px", borderRadius: 100, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, transition: "all 0.3s", background: on ? "linear-gradient(135deg, rgba(107,87,201,0.18), rgba(201,162,75,0.18))" : "transparent", color: on ? "#51409A" : "#6E6353" }}>
                        {c.label}
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Your name" className="cine-field font-body" style={field} />
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" type="email" aria-label="Your email" className="cine-field font-body" style={field} />
                </div>

                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER[category]} rows={4} aria-label="Your message" className="cine-field font-body"
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 90, padding: "13px 15px", borderRadius: 14, border: "1px solid #E8E0D2", background: "#fff", fontSize: 14, color: "#2B2519", lineHeight: 1.5, outline: "none", transition: "border-color 0.25s" }} />

                <button onClick={submitForm} disabled={empty} className="font-body"
                  style={{ marginTop: 14, width: "100%", padding: "13px 20px", borderRadius: 100, border: "none", background: empty ? "#C9C2B4" : "linear-gradient(135deg, #6B57C9, #51409A)", color: "#fff", fontSize: 14, fontWeight: 500, cursor: empty ? "not-allowed" : "pointer", transition: "all 0.3s" }}>
                  {SUBMIT_LABEL[category]}
                </button>
                <p className="font-body" style={{ margin: "10px 0 0", fontSize: 11, color: "#9A8F7D", textAlign: "center" }}>
                  Opens your email app, addressed to us — nothing is stored on this site.
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </SiteModalsContext.Provider>
  );
}
