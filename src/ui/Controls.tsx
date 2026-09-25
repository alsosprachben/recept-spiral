import type { BankParams, DitherParams, ViewParams } from "../lib/types";
import { Brightness, Colour } from "../lib/types";
import type { MicState } from "../lib/useMicBank";

interface Props {
  bank: BankParams;
  setBank: (b: BankParams) => void;
  view: ViewParams;
  setView: (v: ViewParams) => void;
  dither: DitherParams;
  setDither: (d: DitherParams) => void;
  renderer: "auto" | "canvas2d";
  setRenderer: (r: "auto" | "canvas2d") => void;
  autoScale: boolean;
  setAutoScale: (a: boolean) => void;
  autoNote: string;
  micState: MicState;
  micInfo: string;
  onStart: () => void;
  onStop: () => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  digits?: number;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 1, unit = "", digits = 0, onChange } = props;
  return (
    <label className="row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="val">{value.toFixed(digits)}{unit}</span>
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 1, onChange } = props;
  return (
    <label className="row">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
    </label>
  );
}

export function Controls(props: Props) {
  const { bank, setBank, view, setView, dither, setDither, renderer, setRenderer, autoScale, setAutoScale,
    autoNote, micState, micInfo, onStart, onStop, collapsed, setCollapsed } = props;
  const running = micState === "running" || micState === "starting";
  const receptors = bank.bins * bank.octaves * 3;

  return (
    <div className={collapsed ? "panel collapsed" : "panel"}>
      <div className="panel-head">
        <h1>Receptor Spiral</h1>
        <button onClick={() => setCollapsed(!collapsed)} title={collapsed ? "expand" : "collapse"}>
          {collapsed ? "+" : "−"}
        </button>
      </div>

      {collapsed ? null : (
        <>
          <fieldset>
            <legend>receptor bank</legend>
            <NumberField
              label="bins / octave"
              value={bank.bins}
              min={1}
              max={4000}
              onChange={(v) => setBank({ ...bank, bins: Math.round(v) })}
            />
            <NumberField
              label="octaves"
              value={bank.octaves}
              min={1}
              max={12}
              onChange={(v) => setBank({ ...bank, octaves: Math.round(v) })}
            />
            <NumberField
              label="lowest Hz"
              value={bank.fRef}
              min={10}
              max={2000}
              step={0.5}
              onChange={(v) => setBank({ ...bank, fRef: v })}
            />
            <NumberField
              label="selectivity 1/q oct"
              value={bank.q}
              min={1}
              max={1000}
              onChange={(v) => setBank({ ...bank, q: v })}
            />
            <label className="row stacked">
              <span>precision</span>
              <select
                value={bank.precision}
                onChange={(e) => setBank({ ...bank, precision: e.target.value as "f32" | "f64" })}
              >
                <option value="f32">float32 — 4-lane SIMD, ~1.8× faster</option>
                <option value="f64">float64 — matches native exactly</option>
              </select>
            </label>
            <label className="row">
              <span>keep within budget</span>
              <input
                type="checkbox"
                checked={autoScale}
                onChange={(e) => setAutoScale(e.target.checked)}
                title="Give up bin density (and float64) automatically when the bank cannot keep up"
              />
            </label>
            <div className="note">
              {receptors.toLocaleString()} receptors ·{" "}
              {(bank.fRef).toFixed(1)}–{(bank.fRef * Math.pow(2, bank.octaves)).toFixed(0)} Hz
            </div>
            {autoNote ? <div className="note warn">{autoNote}</div> : null}
            <button
              className={running ? "action stop" : "action"}
              onClick={running ? onStop : onStart}
            >
              {micState === "starting" ? "starting…" : running ? "stop microphone" : "start microphone"}
            </button>
            {micInfo ? (
              <div className={micState === "error" ? "note err" : "note"}>{micInfo}</div>
            ) : null}
          </fieldset>

          <fieldset>
            <legend>micro-glissando</legend>
            <label className="row">
              <span>sweep receptors</span>
              <input
                type="checkbox"
                checked={dither.enabled}
                onChange={(e) => setDither({ ...dither, enabled: e.target.checked })}
                title="Sweep every receptor's centre frequency slowly, like fixational eye movements"
              />
            </label>
            <Slider
              label="depth"
              value={dither.cents}
              min={1}
              max={50}
              unit=" ¢"
              onChange={(v) => setDither({ ...dither, cents: v })}
            />
            <Slider
              label="rate"
              value={dither.hz}
              min={0.25}
              max={10}
              step={0.25}
              digits={2}
              unit=" Hz"
              onChange={(v) => setDither({ ...dither, hz: v })}
            />
            <div className="note">
              a steady tone fades from the tonal model; a slow, shallow sweep (about half a bin,
              ~1 Hz) keeps it visible and separates close tones
            </div>
          </fieldset>

          <fieldset>
            <legend>display</legend>
            <Slider
              label="floor"
              value={view.floor}
              min={-20}
              max={80}
              unit=" dB"
              onChange={(v) => setView({ ...view, floor: v })}
            />
            <Slider
              label="range"
              value={view.range}
              min={10}
              max={100}
              unit=" dB"
              onChange={(v) => setView({ ...view, range: v })}
            />
            <Slider
              label="decay"
              value={view.decay}
              min={0}
              max={0.98}
              step={0.01}
              digits={2}
              onChange={(v) => setView({ ...view, decay: v })}
            />
            <Slider
              label="band"
              value={view.band}
              min={0.2}
              max={1}
              step={0.05}
              digits={2}
              onChange={(v) => setView({ ...view, band: v })}
            />
            <label className="row stacked">
              <span>brightness</span>
              <select
                value={view.brightness}
                onChange={(e) =>
                  setView({ ...view, brightness: parseInt(e.target.value, 10) as Brightness })}
              >
                <option value={Brightness.Amplitude}>amplitude</option>
                <option value={Brightness.Tonal}>receptor model — tonal only</option>
                <option value={Brightness.TonalAlt}>receptor model — −energy − entropy</option>
              </select>
            </label>
            <label className="row stacked">
              <span>colour</span>
              <select
                value={view.colour}
                onChange={(e) => setView({ ...view, colour: parseInt(e.target.value, 10) as Colour })}
              >
                <option value={Colour.Amplitude}>amplitude</option>
                <option value={Colour.Phase}>lifecycle phase (hue)</option>
                <option value={Colour.FreeEnergy}>free energy — onset red, decay blue</option>
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>renderer</legend>
            <Slider
              label="resolution"
              value={view.resolution}
              min={300}
              max={2000}
              step={50}
              unit=" px"
              onChange={(v) => setView({ ...view, resolution: v })}
            />
            <label className="row stacked">
              <span>backend</span>
              <select
                value={renderer}
                onChange={(e) => setRenderer(e.target.value as "auto" | "canvas2d")}
              >
                <option value="auto">auto — WebGL2, else canvas2d</option>
                <option value="canvas2d">canvas2d</option>
              </select>
            </label>
            <label className="row">
              <span>note labels</span>
              <input
                type="checkbox"
                checked={view.labels}
                onChange={(e) => setView({ ...view, labels: e.target.checked })}
              />
            </label>
          </fieldset>
        </>
      )}
    </div>
  );
}
