/**
 * 04-citation-bar.tsx — The citation bar under every passage (cinematic redesign)
 *
 * From docs/redesign/designs/Answer.dc.html: one gold-edged pill holding
 *   • a gold medal with the source abbreviation (Bg, SB, Cc …) and the
 *     passage's number (6.6), read from the passage's own stored reference;
 *     recorded talks and letters carry a small microphone / envelope and the
 *     year when the date is known;
 *   • "Read in full ↗" — the existing Vedabase link, shown only when the
 *     passage has one;
 *   • "Copy" — the existing copy-with-reference text (app/lib/23-passage-copy),
 *     whose copied state shows a check.
 * The design's "Context" segment is not built (its reviewed backstory list does
 * not exist yet), so the medal and number are a plain label, not a button.
 * Nothing here is written by a model: every part comes from wire fields.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { getBookName } from "@/app/lib/12-provenance";
import { buildPassageCopyText } from "@/app/lib/23-passage-copy";

export interface CitablePassage {
  type: "verse" | "purport" | "book" | "lecture" | "letter";
  reference: string | null;
  url: string | null;
  label: string;
  speaker: string | null;
  speakerUnidentified?: boolean;
  recipient: string | null;
  date: string | null;
  location: string | null;
}

/** Community abbreviations for the medal (never the biblical colon form). */
const SIGLA: Record<string, { medal: string; cite: string; name: string }> = {
  BG: { medal: "Bg", cite: "Bg.", name: "Bhagavad-gītā As It Is" },
  SB: { medal: "SB", cite: "SB", name: "Śrīmad-Bhāgavatam" },
  CC: { medal: "Cc", cite: "Cc.", name: "Śrī Caitanya-caritāmṛta" },
  NOI: { medal: "NoI", cite: "NoI", name: "Nectar of Instruction" },
  ISO: { medal: "Īśo", cite: "Īśo", name: "Śrī Īśopaniṣad" },
  BS: { medal: "Bs", cite: "Bs.", name: "Śrī Brahma-saṁhitā" },
  NBS: { medal: "NBS", cite: "NBS", name: "Nārada Bhakti Sūtra" },
  MMS: { medal: "MMS", cite: "MMS", name: "Mukunda-mālā-stotra" },
};

/** Short medal marks for books cited by prose paragraph. */
const BOOK_MEDALS: Record<string, string> = {
  bg: "Bg", sb: "SB", cc: "Cc", noi: "NoI", iso: "Īśo", bs: "Bs", lob: "LoB", kb: "KB",
  nod: "NoD", ssr: "SSR", tlc: "TLC", tlk: "TLK", tqk: "TQK", sc: "SC", bbd: "BBD",
  bhakti: "Bh", cat: "CaT", josd: "JSD", owk: "OWK", pop: "PoP", poy: "PoY",
  pqpa: "PQ", rv: "RV", cabh: "CBH", spl: "SPL", rkd: "Rām", mbk: "Mbh", ejop: "EJ",
  ekc: "EKC", kcty: "KC", lcfl: "LCL", mog: "MoG", rtw: "RtW", top: "TTP", nbs: "NBS", mms: "MMS",
};

const DIVISIONS: Record<string, string> = { adi: "Ādi", madhya: "Madhya", antya: "Antya" };

function yearOf(date: string | null): string | null {
  const m = (date || "").match(/\b(1[89]\d\d|20\d\d)\b/);
  return m ? m[1] : null;
}

export interface CitationParts {
  /** Text in the gold medal, or an icon kind for talks and letters. */
  medal: string | { icon: "talk" | "letter" };
  /** The number beside the medal, when the reference states one. */
  num: string | null;
  /** Spoken name of the source, for screen readers. */
  source: string;
}

export function citationParts(p: CitablePassage): CitationParts {
  const ref = (p.reference || "").trim();

  if (p.type === "lecture") {
    return { medal: { icon: "talk" }, num: yearOf(p.date), source: p.label || "Recorded talk" };
  }
  if (p.type === "letter") {
    return { medal: { icon: "letter" }, num: yearOf(p.date), source: p.label || "Letter" };
  }
  if (p.type === "book") {
    const slug = ref.match(/^([a-z0-9-]+)(?:\s+¶\s*\d+)?$/i)?.[1]?.toLowerCase() ?? "";
    const medal = BOOK_MEDALS[slug] ?? "Bk";
    return { medal, num: null, source: slug ? getBookName(slug) : p.label };
  }

  const m = ref.match(/^([A-Za-z]{2,4})\s+(.+)$/);
  const siglum = m ? SIGLA[m[1].toUpperCase()] : undefined;
  if (m && siglum) {
    const num = m[2].replace(/^(adi|madhya|antya)\b/i, (d) => DIVISIONS[d.toLowerCase()] ?? d);
    return { medal: siglum.medal, num, source: siglum.name };
  }
  return { medal: "Bk", num: ref || null, source: p.label };
}

/** Plain citation that travels with copied text (unchanged from before). */
export function citeFor(p: CitablePassage): string {
  if (p.type === "book") return getBookName((p.reference || "").replace(/\s+¶.*$/, ""));
  if (p.type === "lecture") {
    return ["Lecture", yearOf(p.date) ?? "", p.location].filter(Boolean).join(" · ");
  }
  if (p.type === "letter") {
    return ["Letter", p.recipient ? `to ${p.recipient}` : "", yearOf(p.date) ?? ""].filter(Boolean).join(" · ");
  }
  const m = (p.reference || "").match(/^([A-Za-z]{2,4})\s+(.+)$/);
  if (m && SIGLA[m[1].toUpperCase()]) return `${SIGLA[m[1].toUpperCase()].cite} ${m[2]}`;
  return p.reference || p.label;
}

function MedalIcon({ kind }: { kind: "talk" | "letter" }) {
  return kind === "talk" ? (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ) : (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}

export default function CitationBar({
  passage,
  copyText,
  glint = false,
}: {
  passage: CitablePassage;
  /** The exact words this card shows; copied with its reference. */
  copyText: string;
  /** The lead card's medal carries the design's slow glint. */
  glint?: boolean;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const parts = citationParts(passage);
  const citation = citeFor(passage);

  const copy = async () => {
    const text = copyText.trim();
    if (!text) return;
    const payload = buildPassageCopyText({
      type: passage.type,
      text,
      speaker: passage.speaker,
      speakerUnidentified: passage.speakerUnidentified,
      citation,
      url: passage.url,
    });
    try {
      await navigator.clipboard.writeText(payload);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied("idle"), 2200);
  };

  const medalText = typeof parts.medal === "string" ? parts.medal : null;

  return (
    <>
      <div className="asp-cbar-row">
        <div className="asp-cbar">
          <div className="asp-cin">
            <span className="asp-cseg asp-cseg-cite">
              <span className="asp-medal" aria-hidden="true" data-long={medalText && medalText.length > 2 ? "true" : undefined}>
                {medalText ?? <MedalIcon kind={(parts.medal as { icon: "talk" | "letter" }).icon} />}
                {glint && <span className="asp-medal-glint" />}
              </span>
              {parts.num && <span className="asp-num" aria-hidden="true">{parts.num}</span>}
              <span className="asp-sr">{parts.num ? `${parts.source} ${parts.num}` : parts.source}</span>
            </span>
            {passage.url && (
              <>
                <span className="asp-cdiv" aria-hidden="true" />
                <a
                  className="asp-cseg"
                  href={passage.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Read ${citation} in full on Vedabase (opens in a new tab)`}
                >
                  Read in full
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 17L17 7M9 7h8v8" />
                  </svg>
                </a>
              </>
            )}
            <span className="asp-cdiv" aria-hidden="true" />
            <button
              type="button"
              className="asp-cseg asp-cseg-copy"
              onClick={copy}
              data-copied={copied === "done" ? "true" : undefined}
              aria-label={copied === "done" ? "Copied with reference" : "Copy with reference"}
            >
              {copied === "done" ? (
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              ) : (
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              )}
              <span className="asp-cseg-copy-label" aria-hidden="true">
                {copied === "done" ? "Copied with reference" : "Copy"}
              </span>
            </button>
          </div>
        </div>
      </div>
      <p className="asp-copy-status" role="status" aria-live="polite" data-state={copied}>
        {copied === "done" ? "Copied with reference" : copied === "failed" ? "Copy failed — long-press the text to copy" : ""}
      </p>
    </>
  );
}
