'use client';

// Animated counter that batches DOM updates via requestAnimationFrame (D49).
// The displayed value eases toward the target value at ~16ms cadence so
// bursty SDK ingest doesn't cause every tick to reflow the layout. Once the
// gap is below the per-format precision the rAF loop stops — otherwise idle
// dashboards burn one frame every 16ms forever (60fps × N counters × N tabs).

import { useEffect, useRef, useState } from 'react';
import { formatUsd as sharedFormatUsd, formatInt } from '@/lib/formatting';

interface LiveCounterProps {
  value: number;
  format: 'usd' | 'int';
}

const CONVERGENCE_EPSILON = 0.005;

export function LiveCounter({ value, format }: LiveCounterProps): React.ReactElement {
  const [displayed, setDisplayed] = useState(value);
  const targetRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    targetRef.current = value;

    const tick = (): void => {
      let converged = false;
      setDisplayed((prev) => {
        const target = targetRef.current;
        const delta = target - prev;
        if (Math.abs(delta) < CONVERGENCE_EPSILON) {
          converged = true;
          return target;
        }
        return prev + delta * 0.25;
      });
      if (!converged) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value]);

  const formatted = format === 'usd' ? sharedFormatUsd(displayed) : formatInt(displayed);
  return <span className="text-3xl font-semibold tabular-nums">{formatted}</span>;
}
