"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  disabled?: boolean;
}

export default function VoiceInput({ onTranscript, onFinalTranscript, disabled }: VoiceInputProps) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!SR);
  }, []);

  const clearError = useCallback(() => {
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setError(null), 3000);
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (final) {
        onFinalTranscript(final.trim());
        stopListening();
      } else if (interim) {
        onTranscript(interim);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "not-allowed") {
        setError("Microphone access denied. Please allow mic access in your browser settings.");
      } else if (event.error === "no-speech") {
        setError("No speech detected. Try again.");
      } else if (event.error !== "aborted") {
        setError("Voice input error. Please try again.");
      }
      clearError();
      stopListening();
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
  }, [onTranscript, onFinalTranscript, stopListening, clearError]);

  const toggle = useCallback(() => {
    if (listening) {
      stopListening();
    } else {
      startListening();
    }
  }, [listening, stopListening, startListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.abort();
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    };
  }, []);

  // Progressive enhancement: hide if not supported
  if (!supported) return null;

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={listening ? "Stop voice input" : "Start voice input"}
        style={{
          width: 44,
          height: 44,
          minWidth: 44,
          minHeight: 44,
          borderRadius: 12,
          border: listening ? "1.5px solid rgba(139,92,246,0.5)" : "1.5px solid rgba(196,181,253,0.3)",
          background: listening ? "rgba(139,92,246,0.12)" : "rgba(139,92,246,0.05)",
          cursor: disabled ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
          opacity: disabled ? 0.4 : 1,
          position: "relative",
          overflow: "visible",
        }}
        onMouseEnter={e => {
          if (!disabled && !listening) {
            e.currentTarget.style.background = "rgba(139,92,246,0.12)";
            e.currentTarget.style.borderColor = "#C4B5FD";
          }
        }}
        onMouseLeave={e => {
          if (!disabled && !listening) {
            e.currentTarget.style.background = "rgba(139,92,246,0.05)";
            e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
          }
        }}
      >
        {/* Pulsing glow ring when listening */}
        {listening && (
          <span
            style={{
              position: "absolute",
              inset: -4,
              borderRadius: 16,
              border: "2px solid rgba(139,92,246,0.4)",
              animation: "voicePulse 1.5s ease-in-out infinite",
              pointerEvents: "none",
            }}
          />
        )}

        {/* Mic icon */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          style={{
            color: listening ? "#7C3AED" : "#9CA3AF",
            transition: "color 0.3s",
          }}
        >
          <path
            d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"
            fill={listening ? "rgba(139,92,246,0.2)" : "none"}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M19 10v2a7 7 0 0 1-14 0v-2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="12"
            y1="19"
            x2="12"
            y2="23"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="8"
            y1="23"
            x2="16"
            y2="23"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Error tooltip */}
      {error && (
        <div
          className="font-body"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "8px 14px",
            borderRadius: 10,
            background: "rgba(255,255,255,0.95)",
            border: "1px solid rgba(239,68,68,0.2)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
            fontSize: 13,
            color: "#DC2626",
            whiteSpace: "nowrap",
            zIndex: 100,
            animation: "fadeIn 0.2s ease-out",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
