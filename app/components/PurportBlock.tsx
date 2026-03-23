"use client";

interface PurportBlockProps {
  text: string;
}

export default function PurportBlock({ text }: PurportBlockProps) {
  return (
    <div
      style={{
        margin: "12px 0 16px 0",
        background: "rgba(139, 92, 246, 0.04)",
        border: "1px solid var(--border-subtle)",
        borderLeft: "3px solid var(--aurora-purple)",
        padding: "24px 28px",
        borderRadius: 20,
      }}
    >
      <p
        className="font-body"
        style={{
          fontSize: 15,
          fontWeight: 300,
          lineHeight: 1.8,
          color: "var(--text-secondary)",
        }}
      >
        {text}
      </p>
    </div>
  );
}
