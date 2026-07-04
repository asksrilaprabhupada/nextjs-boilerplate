/**
 * 04-use-cinematic-reveal.ts — Cinematic reading-page motion hook
 *
 * Shared scroll behavior for the cinematic reading pages. It reproduces the
 * prototype's `componentDidMount`: an `entered` flag flips ~200ms after mount
 * (drives the opening title reveal), and an IntersectionObserver reveals every
 * `[data-creveal]` element once, exactly once, as it enters the viewport.
 *
 * Pass `railFill: true` (His Journey) to also drive the fixed timeline rail's
 * `[data-rail-fill]` height from overall scroll progress via requestAnimationFrame.
 *
 * Returns a `rootRef` to attach to the page wrapper, the `entered` flag, and a
 * `rev(key)` helper returning `{ op, ty }` opacity/translateY pairs.
 */
"use client";

import { useEffect, useRef, useState } from "react";

export function useCinematicReveal(options?: { railFill?: boolean; revealDistance?: number; revealMargin?: number }) {
  const railFill = options?.railFill ?? false;
  const revealDistance = options?.revealDistance ?? 44;
  const revealMargin = options?.revealMargin ?? 60;
  const rootRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setEntered(true), 200));

    let raf = 0;
    if (railFill) {
      const loop = () => {
        const fill = rootRef.current?.querySelector<HTMLElement>("[data-rail-fill]");
        if (fill) {
          const doc = document.documentElement;
          const p = Math.max(0, Math.min(1, window.scrollY / (doc.scrollHeight - window.innerHeight)));
          fill.style.height = (p * 100).toFixed(2) + "%";
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    let io: IntersectionObserver | null = null;
    const setup = setTimeout(() => {
      const root = rootRef.current;
      if (!root) return;
      io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const key = entry.target.getAttribute("data-creveal");
            if (key) setRevealed((s) => ({ ...s, [key]: true }));
            io?.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: `0px 0px -${revealMargin}px 0px` });
      root.querySelectorAll("[data-creveal]").forEach((el) => io?.observe(el));
    }, 300);

    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(setup);
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [railFill, revealMargin]);

  const rev = (k: string) => (revealed[k] ? { op: 1, ty: "0px" } : { op: 0, ty: `${revealDistance}px` });

  return { rootRef, entered, revealed, rev };
}
