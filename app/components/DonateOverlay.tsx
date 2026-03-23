"use client";

export default function DonateOverlay() {
  return (
    <div>
      <h2
        className="font-cormorant"
        style={{
          fontSize: "1.6rem",
          fontWeight: 500,
          color: "var(--text-primary)",
          marginBottom: 20,
        }}
      >
        Support this project
      </h2>
      <div
        className="font-cormorant"
        style={{
          fontSize: "1rem",
          lineHeight: 1.8,
          color: "var(--text-secondary)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <p>
          Ask Śrīla Prabhupāda is free, open source, and entirely volunteer-built. We believe
          Śrīla Prabhupāda&apos;s teachings should be accessible to everyone, without barriers.
        </p>
        <p>
          Your donations help cover server costs, API usage for scripture search, and
          ongoing development to improve the platform for devotees worldwide.
        </p>
        <p>
          Every contribution, no matter how small, helps keep this service running and
          expanding to serve more devotees.
        </p>
      </div>
      <button
        className="font-dm-sans"
        style={{
          marginTop: 24,
          padding: "14px 32px",
          borderRadius: 12,
          border: "none",
          background: "var(--saffron)",
          color: "#080E1A",
          fontSize: "0.95rem",
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxShadow: "var(--shadow-saffron-glow)",
          transition: "all 0.3s ease",
          width: "100%",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--saffron-light)";
          e.currentTarget.style.transform = "translateY(-2px)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--saffron)";
          e.currentTarget.style.transform = "translateY(0)";
        }}
      >
        Contribute
      </button>
    </div>
  );
}
