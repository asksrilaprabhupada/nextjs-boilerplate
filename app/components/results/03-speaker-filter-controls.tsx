/**
 * 03-speaker-filter-controls.tsx — Speaker-filter status and toggle.
 *
 * This control intentionally renders even when a response contains no
 * passages: a speaker-filtered empty result must always offer a way back to
 * the complete recorded-conversation search.
 */

export interface SpeakerFilterControlsProps {
  passageCount: number;
  additionalCount: number;
  onlyHis: boolean;
  speakerFiltered: boolean;
  onToggle: () => void;
}

export default function SpeakerFilterControls({
  passageCount,
  additionalCount,
  onlyHis,
  speakerFiltered,
  onToggle,
}: SpeakerFilterControlsProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: "clamp(36px,6vh,54px)", opacity: 1, transition: "opacity 0.9s ease 0.4s" }}>
      {passageCount > 0 && (
        <span className="font-body" style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "#6E6353", background: "rgba(107,87,201,0.07)", border: "1px solid #E8E0D2", borderRadius: 100, padding: "6px 14px" }}>
          {passageCount} {passageCount === 1 ? "passage" : "passages"} in full
          {additionalCount > 0 && <> · {additionalCount.toLocaleString("en-US")} more as citations below</>}
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        className="font-body"
        aria-pressed={onlyHis}
        title="Restrict recorded talks to explicitly labelled Śrīla Prabhupāda segments"
        style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: onlyHis ? "#FFFFFF" : "#51409A", background: onlyHis ? "linear-gradient(135deg, #6B57C9, #51409A)" : "rgba(107,87,201,0.06)", border: "1px solid #E8E0D2", borderRadius: 100, padding: "6px 14px", cursor: "pointer" }}
      >
        {onlyHis ? "✓ " : ""}Śrīla Prabhupāda’s words only
      </button>
      <span className="font-body" style={{ fontSize: 12, fontWeight: 500, color: "#9A8F7D" }}>
        {speakerFiltered
          ? "Recorded talks contain only explicitly labelled Śrīla Prabhupāda segments."
          : "Recorded conversations may include other identified or unidentified speakers."}
      </span>
    </div>
  );
}
