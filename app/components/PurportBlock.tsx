"use client";

interface PurportBlockProps {
  text: string;
}

export default function PurportBlock({ text }: PurportBlockProps) {
  return (
    <div className="purport-block" style={{ margin: "20px 0" }}>
      <p
        className="font-cormorant"
        style={{
          fontSize: "0.98rem",
          fontWeight: 400,
          lineHeight: 1.8,
          color: "var(--text-body)",
        }}
      >
        {text}
      </p>
    </div>
  );
}
