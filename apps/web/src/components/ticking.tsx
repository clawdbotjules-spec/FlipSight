"use client";

/**
 * Money value that ticks from its previous value to the next. Lives in its
 * own module so the motion runtime stays out of the feed's critical chunk
 * (only chart-heavy screens import this).
 */
import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";
import { usd } from "@/lib/format";

export function TickingMoney({
  value,
  className = "",
  sign = false,
}: {
  value: number;
  className?: string;
  sign?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      el.textContent = usd(value, { sign });
      prev.current = value;
      return;
    }
    const controls = animate(prev.current, value, {
      duration: 0.7,
      ease: "easeOut",
      onUpdate: (v) => {
        el.textContent = usd(v, { sign });
      },
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, sign, reduced]);

  return (
    <span ref={ref} className={`num ${className}`}>
      {usd(value, { sign })}
    </span>
  );
}
