import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BankParams, BankStats } from "./types";

/** how often the controller looks at the budget */
const TICK_MS = 1000;
/** above this share of the frame budget, give something up */
const HIGH = 85;
/** below this, start giving it back */
const LOW = 45;
/**
 * Re-initialising the bank restarts every receptor, so a change is visible (the spiral
 * refills over the receptors' rise time) and must not happen often. Shedding is allowed to
 * react quickly; recovery is deliberately slow, so a brief quiet passage does not cause a
 * cycle of restore-and-shed.
 */
const SHED_COOLDOWN_MS = 3000;
const RECOVER_COOLDOWN_MS = 10000;
/** multiplicative step on bin density */
const STEP = 0.7;
/** never go below a semitone of resolution — past that the display stops meaning anything */
const MIN_BINS = 12;

interface Scale {
  binsFactor: number;
  forcedF32: boolean;
}

const UNSCALED: Scale = { binsFactor: 1, forcedF32: false };

export interface AutoScale {
  /** what the bank should actually run — pass this to useMicBank */
  effective: BankParams;
  /** true when running below what was asked for */
  active: boolean;
  note: string;
}

/**
 * Keeps the bank inside its real-time budget by giving up fidelity when it cannot keep up.
 *
 * The budget is the wasm processing time as a share of the audio each frame covers: at
 * 100% the bank is exactly keeping up and any hiccup makes it fall behind, so the target
 * is comfortably under that. Two things are given up, cheapest first:
 *
 *   1. float64 → float32 — about 1.8x faster for ~1e-5 relative error, which is invisible
 *      here. Only if float64 was asked for.
 *   2. bin density — the direct cost lever, stepped down multiplicatively. Selectivity
 *      (`q`) is deliberately left alone: it sets what the receptors *are*, not how many.
 *
 * Recovery reverses that order, so precision is the last thing restored.
 */
export function useAutoScale(
  requested: BankParams,
  enabled: boolean,
  sample: () => BankStats | null,
): AutoScale {
  const [scale, setScale] = useState<Scale>(UNSCALED);
  const scaleRef = useRef<Scale>(UNSCALED);
  const lastChangeRef = useRef(0);
  const requestedRef = useRef(requested);
  const sampleRef = useRef(sample);
  sampleRef.current = sample;

  const apply = useCallback((next: Scale) => {
    scaleRef.current = next;
    lastChangeRef.current = performance.now();
    setScale(next);
  }, []);

  // The user changing anything is a fresh statement of intent: honour it exactly, and let
  // the controller earn its way back down from there.
  useEffect(() => {
    requestedRef.current = requested;
    scaleRef.current = UNSCALED;
    lastChangeRef.current = performance.now();
    setScale(UNSCALED);
  }, [requested]);

  useEffect(() => {
    if (!enabled) {
      if (scaleRef.current !== UNSCALED) apply(UNSCALED);
      return;
    }

    const timer = window.setInterval(() => {
      const s = sampleRef.current();
      // no measurement yet (just (re)started), or not enough to judge
      if (!s || s.blockMs <= 0 || s.procMs <= 0) return;

      const budget = (100 * s.procMs) / s.blockMs;
      const since = performance.now() - lastChangeRef.current;
      const cur = scaleRef.current;
      const req = requestedRef.current;

      if (budget > HIGH && since > SHED_COOLDOWN_MS) {
        if (req.precision === "f64" && !cur.forcedF32) {
          apply({ ...cur, forcedF32: true });
        } else if (Math.round(req.bins * cur.binsFactor) > MIN_BINS) {
          apply({ ...cur, binsFactor: cur.binsFactor * STEP });
        }
        return;
      }

      if (budget < LOW && since > RECOVER_COOLDOWN_MS) {
        if (cur.binsFactor < 1) {
          apply({ ...cur, binsFactor: Math.min(1, cur.binsFactor / STEP) });
        } else if (cur.forcedF32) {
          apply({ ...cur, forcedF32: false });
        }
      }
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [enabled, apply]);

  const effective = useMemo<BankParams>(() => ({
    ...requested,
    bins: Math.max(MIN_BINS, Math.round(requested.bins * scale.binsFactor)),
    precision: scale.forcedF32 ? "f32" : requested.precision,
  }), [requested, scale]);

  const active = effective.bins !== requested.bins || effective.precision !== requested.precision;

  let note = "";
  if (active) {
    const parts: string[] = [];
    if (effective.bins !== requested.bins) parts.push(`${effective.bins} bins/octave`);
    if (effective.precision !== requested.precision) parts.push("float32");
    note = `auto: running at ${parts.join(", ")} to stay within the frame budget`;
  }

  return { effective, active, note };
}
