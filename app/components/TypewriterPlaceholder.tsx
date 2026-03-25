"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const QUESTIONS = [
  "What is the purpose of human life?",
  "How to overcome anger?",
  "What happens to the soul after death?",
  "Why is chanting Hare Kṛṣṇa important?",
];

const TYPE_SPEED = 50;
const PAUSE_DURATION = 3000;
const ERASE_SPEED = 25;

interface TypewriterPlaceholderProps {
  isFocused: boolean;
}

export default function TypewriterPlaceholder({ isFocused }: TypewriterPlaceholderProps) {
  const [text, setText] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const [phase, setPhase] = useState<"typing" | "pausing" | "erasing">("typing");
  const charIndex = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (isFocused) {
      clear();
      return;
    }

    const question = QUESTIONS[questionIndex];

    if (phase === "typing") {
      if (charIndex.current < question.length) {
        timerRef.current = setTimeout(() => {
          charIndex.current++;
          setText(question.slice(0, charIndex.current));
        }, TYPE_SPEED);
      } else {
        timerRef.current = setTimeout(() => setPhase("pausing"), 0);
      }
    } else if (phase === "pausing") {
      timerRef.current = setTimeout(() => setPhase("erasing"), PAUSE_DURATION);
    } else if (phase === "erasing") {
      if (charIndex.current > 0) {
        timerRef.current = setTimeout(() => {
          charIndex.current--;
          setText(question.slice(0, charIndex.current));
        }, ERASE_SPEED);
      } else {
        const next = (questionIndex + 1) % QUESTIONS.length;
        setQuestionIndex(next);
        setPhase("typing");
      }
    }

    return clear;
  }, [isFocused, text, phase, questionIndex, clear]);

  if (isFocused) return null;

  return (
    <span
      className="font-body typewriter-placeholder"
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 24,
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: 17,
        color: "#6B7280",
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
      }}
    >
      {text}
      <span
        style={{
          display: "inline-block",
          width: 2,
          height: "1.2em",
          background: "#8B5CF6",
          marginLeft: 1,
          animation: "typewriterBlink 0.8s step-end infinite",
          opacity: 0.7,
        }}
      />
    </span>
  );
}
