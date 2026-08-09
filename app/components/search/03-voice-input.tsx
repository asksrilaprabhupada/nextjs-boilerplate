/**
 * 03-voice-input.tsx — Voice Input Button
 *
 * Provides a microphone button that uses the Web Speech API for voice-to-text search input.
 * Lets users speak their questions instead of typing them.
 */
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
      className="voice-btn"
      data-recording={recording ? "1" : undefined}
      style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? "default" : "pointer" }}
    >
      {/* Calm concentric ripple while listening (not a jittery waveform). */}
      {recording && (
        <>
          <span className="v-ripple" aria-hidden="true" />
          <span className="v-ripple v-ripple-2" aria-hidden="true" />
        </>
      )}

      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="v-ico">
        <path
          d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"
          fill="none"
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
        .voice-btn {
          position: relative;
          width: 38px; height: 38px; min-width: 38px; min-height: 38px;
          border-radius: 11px;
          border: 1.5px solid color-mix(in srgb, var(--accent) 50%, transparent);
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          display: flex; align-items: center; justify-content: center; overflow: visible;
          transition: background var(--dur-3) var(--ease-standard),
            border-color var(--dur-3) var(--ease-standard),
            border-radius var(--dur-3) var(--ease-standard);
        }
        .voice-btn:hover {
          background: color-mix(in srgb, var(--accent) 20%, transparent);
          border-color: var(--accent);
        }
        .voice-btn[data-recording] {
          border-radius: 50%;
          border-color: var(--accent);
          background: var(--accent-tint);
        }
        .v-ico { color: var(--accent-strong); transition: color var(--dur-3) var(--ease-standard); }
        .v-ripple {
          position: absolute; inset: -2px; border-radius: 50%;
          border: 1.5px solid color-mix(in srgb, var(--accent) 45%, transparent);
          pointer-events: none; opacity: 0;
          animation: vRipple 1.9s var(--ease-decelerate) infinite;
        }
        .v-ripple-2 { animation-delay: 0.95s; }
        @keyframes vRipple {
          0%   { transform: scale(0.85); opacity: 0.55; }
          100% { transform: scale(2.3); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .v-ripple { animation: none; display: none; }
        }
      `}</style>
    </button>
  );
}