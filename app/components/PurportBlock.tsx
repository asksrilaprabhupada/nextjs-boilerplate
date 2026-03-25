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
        border: "1px solid rgba(196, 181, 253, 0.20)",
        borderLeft: "3px solid #7C3AED",
        padding: "24px 28px",
        borderRadius: 20,
      }}
    >
      <p
        className="font-body"
        style={{
          fontSize: 15,
          fontWeight: 400,
          lineHeight: 1.8,
          color: "#374151",
        }}
      >
        {text}
      </p>
    </div>
  );
}
