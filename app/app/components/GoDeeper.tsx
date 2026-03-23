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
          background: "var(--border-subtle)",
        }}
      />
      <p
        className="font-cormorant"
        style={{
          fontSize: "1.02rem",
          fontStyle: "italic",
          color: "var(--text-secondary)",
          textAlign: "center",
          maxWidth: 480,
          lineHeight: 1.6,
        }}
      >
        {transitionText}
      </p>
      <button
        onClick={onClick}
        className="font-dm-sans"
        style={{
          padding: "10px 24px",
          borderRadius: 10,
          border: "1.5px solid var(--saffron)",
          background: "transparent",
          color: "var(--saffron)",
          fontSize: "0.85rem",
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          transition: "all 0.3s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(232,130,12,0.08)";
          e.currentTarget.style.boxShadow = "var(--shadow-saffron-glow)";
          e.currentTarget.style.transform = "translateY(-2px)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.boxShadow = "none";
          e.currentTarget.style.transform = "translateY(0)";
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
