"use client";

import { useState, useEffect } from "react";

interface DonateData {
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifscCode: string;
  remark: string;
  upiId: string;
}

export default function DonateOverlay() {
  const [data, setData] = useState<DonateData | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/donate.json")
      .then((res) => res.json())
      .then((json) => setData(json))
      .catch(() => {});
  }, []);

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // clipboard API may fail in some contexts
    }
  };

  const fields: { label: string; key: keyof DonateData }[] = [
    { label: "Bank Name", key: "bankName" },
    { label: "Account Name", key: "accountName" },
    { label: "Account Number", key: "accountNumber" },
    { label: "IFSC Code", key: "ifscCode" },
    { label: "Remark", key: "remark" },
    { label: "UPI ID", key: "upiId" },
  ];

  return (
    <div>
      <h2
        className="font-display"
        style={{
          fontSize: "1.5rem",
          fontWeight: 400,
          color: "var(--text-primary)",
          marginBottom: 8,
          letterSpacing: "-0.02em",
        }}
      >
        Support this project
      </h2>
      <p
        className="font-body"
        style={{
          fontSize: 15,
          lineHeight: 1.7,
          fontWeight: 300,
          color: "var(--text-muted)",
          marginBottom: 24,
        }}
      >
        Your donations help cover server costs and ongoing development to serve devotees worldwide.
      </p>

      <div
        style={{
          background: "var(--bg-surface)",
          borderRadius: 20,
          border: "1px solid var(--border-subtle)",
          overflow: "hidden",
        }}
      >
        {data &&
          fields.map((field, i) => {
            const value = data[field.key];
            if (!value) return null;
            return (
              <div
                key={field.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 20px",
                  borderBottom:
                    i < fields.length - 1 ? "1px solid var(--border-subtle)" : "none",
                  gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="font-body"
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "var(--text-muted)",
                      marginBottom: 2,
                    }}
                  >
                    {field.label}
                  </div>
                  <div
                    className="font-body"
                    style={{
                      fontSize: 15,
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {value}
                  </div>
                </div>
                <button
                  onClick={() => handleCopy(value, field.key)}
                  aria-label={`Copy ${field.label}`}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    border: "1px solid var(--border-subtle)",
                    background: copiedField === field.key ? "var(--aurora-violet)" : "var(--bg-card)",
                    color: copiedField === field.key ? "#fff" : "var(--text-muted)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "all 0.3s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (copiedField !== field.key) {
                      e.currentTarget.style.borderColor = "var(--border-glow)";
                      e.currentTarget.style.color = "var(--aurora-violet)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (copiedField !== field.key) {
                      e.currentTarget.style.borderColor = "var(--border-subtle)";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }
                  }}
                >
                  {copiedField === field.key ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="2" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}

        {data && !Object.values(data).some((v) => v) && (
          <div
            className="font-body"
            style={{
              padding: "32px 20px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontStyle: "italic",
              fontWeight: 300,
            }}
          >
            Bank details will be updated soon.
          </div>
        )}
      </div>
    </div>
  );
}
