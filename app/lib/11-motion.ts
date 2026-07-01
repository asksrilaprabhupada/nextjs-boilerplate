/**
 * 11-motion.ts — Shared motion tokens for Framer Motion (JS side)
 *
 * Mirrors the CSS motion tokens in globals.css so JS-driven animation uses the
 * same durations, easings, and the one gentle "settling" spring. The spring
 * cannot be expressed in CSS, so it lives here as the canonical source.
 * Import these instead of hard-coding numbers in components.
 */

/** Durations in seconds (Framer Motion units). Mirror of --dur-1…5. */
export const DUR = {
  d1: 0.1,
  d2: 0.16,
  d3: 0.24,
  d4: 0.36,
  d5: 0.5,
} as const;

/** Cubic-bezier easings as Framer tuples. Mirror of --ease-* in globals.css. */
export const EASE = {
  standard: [0.2, 0, 0, 1] as [number, number, number, number],
  decelerate: [0, 0, 0.2, 1] as [number, number, number, number],
  accelerate: [0.4, 0, 1, 1] as [number, number, number, number],
} as const;

/** The single gentle settling spring (used for shared-element / layout motion). */
export const SPRING_SETTLE = {
  type: "spring",
  stiffness: 300,
  damping: 30,
} as const;

/** Stagger between composing-in passages (only the first ~8–10 are staggered). */
export const STAGGER_STEP = 0.07;
