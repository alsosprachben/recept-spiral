import { useCallback, useRef, useState } from "react";
import { DEFAULT_BANK, DEFAULT_VIEW } from "./lib/types";
import type { BankParams, BankStats, RenderStats, ViewParams } from "./lib/types";
import { useAutoScale } from "./lib/useAutoScale";
import { useMicBank } from "./lib/useMicBank";
import { SpiralView } from "./render/SpiralView";
import type { SpiralHandle } from "./render/SpiralView";
import { Controls } from "./ui/Controls";
import { StatusBar } from "./ui/StatusBar";

export function App() {
  const [bank, setBank] = useState<BankParams>(DEFAULT_BANK);
  const [view, setView] = useState<ViewParams>(DEFAULT_VIEW);
  const [renderer, setRenderer] = useState<"auto" | "canvas2d">("auto");
  const [autoScale, setAutoScale] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [stats, setStats] = useState<{ render: RenderStats | null; bank: BankStats | null }>({
    render: null,
    bank: null,
  });

  const spiralRef = useRef<SpiralHandle>(null);
  // Per-frame bank timing is written here at 60 Hz and only lifted into React state once a
  // second, when the renderer reports its own stats.
  const bankStatsRef = useRef<BankStats | null>(null);

  const onFrame = useCallback((frame: ArrayBuffer, s: BankStats) => {
    bankStatsRef.current = s;
    spiralRef.current?.ingest(frame);
  }, []);

  const onReset = useCallback(() => {
    bankStatsRef.current = null;
    spiralRef.current?.reset();
  }, []);

  const onStats = useCallback((render: RenderStats) => {
    setStats({ render, bank: bankStatsRef.current });
  }, []);

  const sampleBank = useCallback(() => bankStatsRef.current, []);
  const auto = useAutoScale(bank, autoScale, sampleBank);

  const mic = useMicBank(auto.effective, onFrame, onReset);
  const running = mic.state === "running" || mic.state === "starting";

  return (
    <>
      <SpiralView key={renderer} ref={spiralRef} view={view} renderer={renderer} onStats={onStats} />

      <Controls
        bank={bank}
        setBank={setBank}
        view={view}
        setView={setView}
        renderer={renderer}
        setRenderer={setRenderer}
        autoScale={autoScale}
        setAutoScale={setAutoScale}
        autoNote={auto.note}
        micState={mic.state}
        micInfo={mic.info}
        onStart={mic.start}
        onStop={mic.stop}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />

      <StatusBar render={stats.render} bank={stats.bank} audio={mic.audio} running={running} />

      {mic.state === "idle" || mic.state === "error" ? (
        <div className="overlay">
          <div className="card">
            <h2>Receptor Spiral</h2>
            <p>
              A bank of scale-space receptors — exponential averages standing in for cochlear
              hair cells, not an FFT — runs on your microphone in WebAssembly and is drawn as a
              pitch spiral: one turn per octave, so octaves line up radially and a harmonic
              series keeps its shape at every pitch.
            </p>
            <p>
              Audio never leaves your browser. {(bank.bins * bank.octaves * 3).toLocaleString()}{" "}
              receptors at 60 frames a second.
            </p>
            {mic.state === "error" ? <p className="note err">{mic.info}</p> : null}
            <button onClick={mic.start}>
              {mic.state === "error" ? "try again" : "start microphone"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
