"use client";

/**
 * Circular 0–100 score gauge; the arc sweeps in on mount via a plain CSS
 * transition (no animation library — this sits in the feed's critical chunk).
 */
import { useEffect, useRef, useState } from "react";

export function scoreColor(score: number): string {
  if (score >= 75) return "var(--color-profit)";
  if (score >= 55) return "var(--color-acc)";
  if (score >= 35) return "var(--color-warn)";
  return "var(--color-loss)";
}

export function ScoreRing({
  score,
  size = 48,
  stroke = 3.5,
  animate = true,
}: {
  score: number;
  size?: number;
  stroke?: number;
  animate?: boolean;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const target = c * (1 - Math.min(100, Math.max(0, score)) / 100);
  const color = scoreColor(score);
  const [offset, setOffset] = useState(animate ? c : target);
  const raf = useRef(0);

  useEffect(() => {
    if (!animate) {
      setOffset(target);
      return;
    }
    // Double rAF so the initial (full-offset) frame commits before the sweep.
    raf.current = requestAnimationFrame(() => {
      raf.current = requestAnimationFrame(() => setOffset(target));
    });
    return () => cancelAnimationFrame(raf.current);
  }, [target, animate]);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={`Score ${score}/100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.14)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{
            transition: "stroke-dashoffset 0.9s cubic-bezier(0.22, 1, 0.36, 1)",
            filter: `drop-shadow(0 0 4px ${color})`,
          }}
        />
      </svg>
      <span
        className="num absolute inset-0 grid place-items-center font-semibold"
        style={{ color, fontSize: size * 0.3 }}
      >
        {score}
      </span>
    </div>
  );
}
