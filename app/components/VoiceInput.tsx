"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  disabled?: boolean;
}

export default function VoiceInput({ onTranscript, onFinalTranscript, disabled }: VoiceInputProps) {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedRef = useRef("");

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!SR);
  }, []);

  const clearError = useCallback(() => {
    if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    errorTimeoutRef.current = setTimeout(() => setError(null), 3000);
  }, []);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    // Send accumulated transcript to the search input
    const finalText = accumulatedRef.current.trim();
    if (finalText) {
      onFinalTranscript(finalText);
    }
    setRecording(false);
    setInterimText("");
    accumulatedRef.current = "";
  }, [onFinalTranscript]);

  const cancelRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    setRecording(false);
    setInterimText("");
    accumulatedRef.current = "";
  }, []);

  const startRecording = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalPart = "";
      let interimPart = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalPart += transcript;
        } else {
          interimPart += transcript;
        }
      }

      if (finalPart) {
        accumulatedRef.current += finalPart;
        // Show interim updates in the modal
        onTranscript(accumulatedRef.current.trim());
      }
      setInterimText(interimPart);
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
      setRecording(false);
      setInterimText("");
      accumulatedRef.current = "";
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      // If still in recording state, recognition ended naturally — finalize
      if (recognitionRef.current) {
        const finalText = accumulatedRef.current.trim();
        if (finalText) {
          onFinalTranscript(finalText);
        }
        setRecording(false);
        setInterimText("");
        accumulatedRef.current = "";
        recognitionRef.current = null;
      }
    };

    recognitionRef.current = recognition;
    setError(null);
    setRecording(true);
    setInterimText("");
    accumulatedRef.current = "";
    recognition.start();
  }, [onTranscript, onFinalTranscript, clearError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.abort();
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    };
  }, []);

  if (!supported) return null;

  const displayText = (accumulatedRef.current + " " + interimText).trim();

  return (
    <>
      {/* Mic button */}
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button
          type="button"
          onClick={startRecording}
          disabled={disabled || recording}
          aria-label="Start voice input"
          style={{
            width: 44,
            height: 44,
            minWidth: 44,
            minHeight: 44,
            borderRadius: 12,
            border: "1.5px solid rgba(196,181,253,0.3)",
            background: "rgba(139,92,246,0.05)",
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
            if (!disabled) {
              e.currentTarget.style.background = "rgba(139,92,246,0.12)";
              e.currentTarget.style.borderColor = "#C4B5FD";
            }
          }}
          onMouseLeave={e => {
            if (!disabled) {
              e.currentTarget.style.background = "rgba(139,92,246,0.05)";
              e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
            }
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: "#6B7280", transition: "color 0.3s" }}>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

      {/* Recording overlay/modal */}
      {recording && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(30,27,75,0.4)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            animation: "fadeInOverlay 0.25s ease-out",
          }}
          onClick={cancelRecording}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "rgba(255,255,255,0.95)",
              borderRadius: 28,
              padding: "40px 36px 32px",
              width: "90%",
              maxWidth: 420,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 24,
              boxShadow: "0 24px 64px rgba(111,74,177,0.2), 0 0 0 1px rgba(196,181,253,0.3)",
              animation: "voiceModalIn 0.3s cubic-bezier(0.16,1,0.3,1)",
            }}
          >
            {/* Pulsing circle */}
            <div style={{ position: "relative", width: 96, height: 96, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {/* Outer pulse ring 1 */}
              <span style={{
                position: "absolute", inset: -8, borderRadius: "50%",
                border: "2px solid rgba(232,137,28,0.3)",
                animation: "voiceRecordPulse 2s ease-in-out infinite",
              }} />
              {/* Outer pulse ring 2 */}
              <span style={{
                position: "absolute", inset: -16, borderRadius: "50%",
                border: "1.5px solid rgba(139,92,246,0.2)",
                animation: "voiceRecordPulse 2s ease-in-out infinite 0.5s",
              }} />
              {/* Main circle */}
              <div style={{
                width: 96, height: 96, borderRadius: "50%",
                background: "linear-gradient(135deg, rgba(232,137,28,0.15), rgba(139,92,246,0.15))",
                border: "2px solid rgba(232,137,28,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
                animation: "voiceCirclePulse 1.5s ease-in-out infinite",
              }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ color: "#E8891C" }}>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" fill="rgba(232,137,28,0.2)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
            </div>

            {/* Label */}
            <p className="font-body" style={{ fontSize: 16, fontWeight: 600, color: "#1E1B4B", letterSpacing: "-0.01em" }}>
              Listening...
            </p>

            {/* Transcript preview */}
            {displayText && (
              <div
                className="font-body"
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  borderRadius: 14,
                  background: "rgba(139,92,246,0.05)",
                  border: "1px solid rgba(196,181,253,0.3)",
                  fontSize: 15,
                  color: "#374151",
                  lineHeight: 1.6,
                  minHeight: 44,
                  maxHeight: 120,
                  overflowY: "auto",
                  textAlign: "center",
                }}
              >
                {displayText}
                {interimText && (
                  <span style={{ color: "#6B7280", fontStyle: "italic" }}></span>
                )}
              </div>
            )}

            {/* Buttons */}
            <div style={{ display: "flex", gap: 12, width: "100%" }}>
              <button
                type="button"
                onClick={cancelRecording}
                className="font-body"
                style={{
                  flex: 1,
                  padding: "12px 20px",
                  borderRadius: 14,
                  border: "1px solid rgba(196,181,253,0.3)",
                  background: "rgba(255,255,255,0.8)",
                  fontSize: 14,
                  fontWeight: 500,
                  color: "#6B7280",
                  cursor: "pointer",
                  transition: "all 0.3s var(--ease-out-expo)",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.06)"; e.currentTarget.style.color = "#DC2626"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.3)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.8)"; e.currentTarget.style.color = "#6B7280"; e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={stopRecording}
                className="font-body"
                style={{
                  flex: 1,
                  padding: "12px 20px",
                  borderRadius: 14,
                  border: "none",
                  background: "linear-gradient(135deg, #E8891C, #F5A623)",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#fff",
                  cursor: "pointer",
                  transition: "all 0.3s var(--ease-out-expo)",
                  boxShadow: "0 4px 14px rgba(232,137,28,0.3)",
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(232,137,28,0.4)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "0 4px 14px rgba(232,137,28,0.3)"; }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Animations injected via style tag */}
      <style jsx>{`
        @keyframes fadeInOverlay {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes voiceModalIn {
          from { opacity: 0; transform: scale(0.92) translateY(12px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes voiceRecordPulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 0; transform: scale(1.3); }
        }
        @keyframes voiceCirclePulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
      `}</style>
    </>
  );
}
