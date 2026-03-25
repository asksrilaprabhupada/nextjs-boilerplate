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
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const accumulatedRef = useRef("");

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSupported(!!SR);
  }, []);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    const finalText = accumulatedRef.current.trim();
    if (finalText) {
      onFinalTranscript(finalText);
    }
    setRecording(false);
    accumulatedRef.current = "";
  }, [onFinalTranscript]);

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
        onTranscript(accumulatedRef.current.trim());
      }
      // Show interim text in the input too
      if (interimPart) {
        onTranscript((accumulatedRef.current + interimPart).trim());
      }
    };

    recognition.onerror = () => {
      setRecording(false);
      accumulatedRef.current = "";
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      if (recognitionRef.current) {
        const finalText = accumulatedRef.current.trim();
        if (finalText) {
          onFinalTranscript(finalText);
        }
        setRecording(false);
        accumulatedRef.current = "";
        recognitionRef.current = null;
      }
    };

    recognitionRef.current = recognition;
    setRecording(true);
    accumulatedRef.current = "";
    recognition.start();
  }, [onTranscript, onFinalTranscript]);

  const toggleRecording = useCallback(() => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [recording, stopRecording, startRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.abort();
    };
  }, []);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggleRecording}
      disabled={disabled}
      aria-label={recording ? "Stop voice input" : "Start voice input"}
      style={{
        width: 38,
        height: 38,
        minWidth: 38,
        minHeight: 38,
        borderRadius: recording ? "50%" : 11,
        border: recording ? "2px solid rgba(232,137,28,0.4)" : "1.5px solid rgba(196,181,253,0.3)",
        background: recording
          ? "linear-gradient(135deg, rgba(232,137,28,0.15), rgba(245,166,35,0.15))"
          : "rgba(139,92,246,0.05)",
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
        opacity: disabled ? 0.4 : 1,
        position: "relative",
        overflow: "visible",
        animation: recording ? "voiceBtnPulse 1.8s ease-in-out infinite" : "none",
      }}
      onMouseEnter={e => {
        if (!disabled && !recording) {
          e.currentTarget.style.background = "rgba(139,92,246,0.12)";
          e.currentTarget.style.borderColor = "#C4B5FD";
        }
      }}
      onMouseLeave={e => {
        if (!disabled && !recording) {
          e.currentTarget.style.background = "rgba(139,92,246,0.05)";
          e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)";
        }
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        style={{ color: recording ? "#E8891C" : "#6B7280", transition: "color 0.3s" }}
      >
        <path
          d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"
          fill={recording ? "rgba(232,137,28,0.2)" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>

      <style jsx>{`
        @keyframes voiceBtnPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(232, 137, 28, 0.3); }
          50% { box-shadow: 0 0 0 6px rgba(232, 137, 28, 0); }
        }
      `}</style>
    </button>
  );
}