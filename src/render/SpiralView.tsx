import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { RenderStats, ViewParams } from "../lib/types";
import { SpiralEngine } from "./engine";

export interface SpiralHandle {
  ingest: (frame: ArrayBuffer) => void;
  reset: () => void;
}

interface Props {
  view: ViewParams;
  /** changing this remounts the engine, so it must be a React `key` on this component too */
  renderer: "auto" | "canvas2d";
  /** called about once a second, not per frame */
  onStats: (stats: RenderStats) => void;
}

/**
 * Thin React wrapper around SpiralEngine. The engine owns the animation-frame loop and all
 * per-frame mutable state; React only feeds it control values and pulls stats on an interval,
 * so a 60 Hz frame stream never touches the React render cycle.
 */
export const SpiralView = forwardRef<SpiralHandle, Props>(function SpiralView(props, ref) {
  const { view, renderer, onStats } = props;
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SpiralEngine | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  useEffect(() => {
    if (!glRef.current || !overlayRef.current) return;
    const engine = new SpiralEngine(
      glRef.current,
      overlayRef.current,
      viewRef.current,
      renderer === "canvas2d",
    );
    engineRef.current = engine;
    engine.start();

    const timer = window.setInterval(() => onStatsRef.current(engine.getStats()), 1000);
    onStatsRef.current(engine.getStats());

    return () => {
      window.clearInterval(timer);
      engine.stop();
      engineRef.current = null;
    };
  }, [renderer]);

  useEffect(() => {
    engineRef.current?.setView(view);
  }, [view]);

  useImperativeHandle(ref, () => ({
    ingest: (frame: ArrayBuffer) => engineRef.current?.ingest(frame),
    reset: () => engineRef.current?.reset(),
  }), []);

  return (
    <div className="stage">
      <canvas ref={glRef} />
      <canvas ref={overlayRef} />
    </div>
  );
});
