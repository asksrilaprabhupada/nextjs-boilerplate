/**
 * 17-self-typing.tsx — The questions that type themselves in the search box
 *
 * Replaces the old character-by-character typewriter
 * (components/search/02-typewriter-placeholder.tsx). Implemented as the design
 * does it (docs/redesign/designs/Ask.dc.html, PhoneAsk.dc.html): each question's
 * letters are rendered ONCE, and CSS animation-delay brings them in on a steady
 * beat — a new letter every 42 ms on desktop and iPad, every 46 ms on phone,
 * each fading in and rising over 560 ms, starting gold and settling into ink.
 * After the last letter a violet cursor fades in and blinks; the full question
 * holds 2.6 s, fades upward over 0.7 s, and the next begins. State changes only
 * twice per question (out, then next), never once per letter. The two
 * identical keyframes asp-chA / asp-chB alternate so the animation restarts.
 *
 * The questions come from public/data/self-typing-questions.json (8 for desktop
 * and iPad, 8 shorter for phone), shuffled on every visit. The overlay sits on
 * top of the real input with pointer-events: none, is aria-hidden (the input
 * keeps its own label), and disappears the moment the input has focus (CSS
 * :focus-within) or text (`hidden`). It starts only once `active` is true, so
 * nothing runs behind the doorway. With reduced motion, one question stands
 * still.
 */
"use client";

import { useEffect, useState } from "react";
import questionsFile from "@/public/data/self-typing-questions.json";

const DESKTOP: readonly string[] = questionsFile.desktop_and_ipad;
const PHONE: readonly string[] = questionsFile.phone;

function shuffled(list: readonly string[]): string[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

interface Run {
  questions: string[];
  step: number;
  reduce: boolean;
}

export default function SelfTyping({ active, hidden }: { active: boolean; hidden: boolean }) {
  const [run, setRun] = useState<Run | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"in" | "out">("in");

  // Decide the list for this device and shuffle it — on the client only, so the
  // served HTML never has to guess.
  useEffect(() => {
    if (!active) return;
    let phone = false;
    let reduce = false;
    try {
      phone = window.matchMedia("(max-width: 767px)").matches;
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* defaults: desktop list, motion on */
    }
    setRun({ questions: shuffled(phone ? PHONE : DESKTOP), step: phone ? 46 : 42, reduce });
    setIndex(0);
    setPhase("in");
  }, [active]);

  // Two state changes per question: fade it out, then begin the next.
  useEffect(() => {
    if (!run || run.reduce || run.questions.length === 0) return;
    const letters = Array.from(run.questions[index % run.questions.length].normalize("NFC")).length;
    let inner: number | undefined;
    const outer = window.setTimeout(() => {
      setPhase("out");
      inner = window.setTimeout(() => {
        setIndex((i) => i + 1);
        setPhase("in");
      }, 750);
    }, letters * run.step + 560 + 2600);
    return () => {
      window.clearTimeout(outer);
      if (inner !== undefined) window.clearTimeout(inner);
    };
  }, [run, index]);

  if (!run || run.questions.length === 0) {
    return <span className="asp-tw" aria-hidden="true" data-hidden={hidden ? "true" : "false"} />;
  }

  const name = index % 2 ? "asp-chB" : "asp-chA";
  const chars = Array.from(run.questions[index % run.questions.length].normalize("NFC"));

  return (
    <span className="asp-tw" aria-hidden="true" data-hidden={hidden ? "true" : "false"}>
      <span className="asp-tw-line" data-phase={phase}>
        {chars.map((ch, k) => (
          <span
            key={k}
            className="asp-ch"
            style={run.reduce ? undefined : { animation: `${name} 560ms cubic-bezier(.16,1,.3,1) ${k * run.step}ms both` }}
          >
            {ch === " " ? " " : ch}
          </span>
        ))}
        <span
          className="asp-caret-wrap"
          style={run.reduce ? undefined : { animation: `${name} 400ms ease ${chars.length * run.step + 300}ms both` }}
        >
          <span className="asp-caret" />
        </span>
      </span>
    </span>
  );
}
