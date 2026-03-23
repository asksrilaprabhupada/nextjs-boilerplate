"use client";

interface GoDeeperProps {
  transitionText: string;
  onClick: () => void;
}

export default function GoDeeper({ transitionText, onClick }: GoDeeperProps) {
  return (
    <div
      style={{
        padding: "40px 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 200,
          height: 1,
          background: "rgba(196, 181, 253, 0.3)",
        }}
      />
      <p
        className="font-display"
        style={{
          fontSize: "1.02rem",
          fontStyle: "italic",
          color: "#9CA3AF",
          textAlign: "center",
          maxWidth: 480,
          lineHeight: 1.6,
        }}
      >
        {transitionText}
      </p>
      <button
        onClick={onClick}
        className="btn-ghost"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        Go Deeper
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
