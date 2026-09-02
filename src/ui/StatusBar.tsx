import type { BankStats, RenderStats } from "../lib/types";

interface Props {
  render: RenderStats | null;
  bank: BankStats | null;
  running: boolean;
}

function Sep() {
  return <span className="sep">│</span>;
}

export function StatusBar({ render, bank, running }: Props) {
  if (!render) return <div className="status">starting…</div>;

  const { meta } = render;
  const budget = bank && bank.blockMs > 0 ? (100 * bank.procMs) / bank.blockMs : null;
  const budgetClass = budget === null ? "" : budget > 90 ? "err" : budget > 70 ? "warn" : "";

  return (
    <div className="status">
      <b>{render.backend}</b>
      {meta ? (
        <>
          <Sep />
          <b>{meta.sensors.toLocaleString()}</b> sensors · {meta.bins}/oct × {meta.octaves} oct ·{" "}
          {meta.fRef.toFixed(1)}–{(meta.fRef * Math.pow(2, meta.octaves)).toFixed(0)} Hz
          <Sep />
          <b>{render.fps.toFixed(0)}</b> frames/s in · <b>{render.drawFps.toFixed(0)}</b> draws/s @{" "}
          {render.drawMs.toFixed(1)} ms ({render.canvasWidth}×{render.canvasHeight})
        </>
      ) : (
        <>
          <Sep />
          {running ? "waiting for the first frame…" : "microphone stopped"}
        </>
      )}
      {bank && bank.blockMs > 0 ? (
        <>
          <Sep />
          bank <b>{bank.procMs.toFixed(1)}</b> ms per {bank.blockMs.toFixed(1)} ms block{" "}
          <span className={budgetClass}>({budget!.toFixed(0)}% of budget)</span>
        </>
      ) : null}
      {render.error ? (
        <>
          <Sep />
          <span className="err">{render.error}</span>
        </>
      ) : null}
    </div>
  );
}
