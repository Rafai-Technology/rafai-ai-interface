import { useEffect, useState } from 'react';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Counts a KPI figure up from zero to its target on mount.
 *
 * The strip swaps to skeletons and back on every role switch, so "on mount"
 * is exactly "whenever the dashboard populates" — which is the moment this is
 * meant to sell. Reduced motion jumps straight to the value, and null passes
 * through untouched so a still-loading tile never invents a number.
 */
export function useCountUp(target: number | null, durationMs = 700): number | null {
  const [value, setValue] = useState<number | null>(target === null ? null : 0);

  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setValue(target * easeOutExpo(t));
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setValue(target); // clamp: the eased curve never lands exactly
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
