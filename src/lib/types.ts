/** Header of an RCP1 frame, as produced by bank_wasm.c (and by bank_stream.c in the recept repo). */
export interface FrameMeta {
  /** sample index at the end of the block */
  time: number;
  sampleRate: number;
  /** sensors per octave */
  bins: number;
  octaves: number;
  sensors: number;
  /** floats per sensor in the payload */
  channels: number;
  /** frequency of sensor 0 */
  fRef: number;
  /** producer wall clock, ms mod 2^32 */
  stamp: number;
  /** payload offset */
  headerSize: number;
}

/** Receptor-bank configuration; a change re-initialises the bank. */
export interface BankParams {
  /** sensors placed per octave — display density */
  bins: number;
  octaves: number;
  /** frequency of the innermost sensor, Hz */
  fRef: number;
  /** receptor selectivity: each bell is 1/q octave wide */
  q: number;
  precision: "f32" | "f64";
}

/**
 * Micro-glissando: every receptor's centre frequency sweeps sinusoidally, the auditory
 * analogue of fixational eye movements. A steady tone otherwise fades from the tonal receptor
 * model (it has no onset left to report); a slow sweep keeps turning its spectral position
 * into temporal change. Both settings are scale-covariant — relative to the bin spacing and
 * to each sensor's own receptor window — so the sweep acts the same at every pitch.
 * Changing it never re-initialises the bank.
 */
export interface DitherParams {
  enabled: boolean;
  /** peak deviation of every centre frequency, as a fraction of the bin spacing */
  depth: number;
  /** sweep period, in each sensor's own (slowest) receptor window */
  windows: number;
}

/** Brightness source: which quantity drives pixel intensity. */
export const enum Brightness {
  /** smoothed receptor magnitude */
  Amplitude = 0,
  /** recept.c "Receptor Model": tonal responses only */
  Tonal = 1,
  /** main.js variant: -energy - entropy, gated the same way */
  TonalAlt = 2,
}

/**
 * Where a sensor's brightness is drawn: at its fixed centre frequency (the place code — what
 * the receptors sense), or at the frequency its receptors' phase says the energy is at
 * (frequency reassignment, the temporal code — what they infer).
 */
export const enum Position {
  Centre = 0,
  Detected = 1,
}

/** Detected mode draws on a grid this many times finer than the bins. */
export const REASSIGN_FACTOR = 4;

/** Colour mapping. */
export const enum Colour {
  Amplitude = 0,
  Phase = 1,
  FreeEnergy = 2,
}

/** View controls; these never re-initialise the bank. */
export interface ViewParams {
  /** dB mapped to black */
  floor: number;
  /** dB from floor to full brightness */
  range: number;
  /** per-frame visual persistence, 0 = none */
  decay: number;
  /** arm width as a fraction of the octave spacing */
  band: number;
  brightness: Brightness;
  colour: Colour;
  position: Position;
  /** detected mode: sensors below this confidence stay at their centre */
  confidence: number;
  /** canvas backing-store size for the short side, px */
  resolution: number;
  labels: boolean;
}

export interface RenderStats {
  backend: "webgl2" | "canvas2d";
  meta: FrameMeta | null;
  /** frames ingested per second */
  fps: number;
  /** draws per second */
  drawFps: number;
  /** smoothed draw time, ms */
  drawMs: number;
  canvasWidth: number;
  canvasHeight: number;
  error: string;
}

export interface BankStats {
  /** smoothed wasm processing time per produced frame, ms */
  procMs: number;
  /** audio duration one frame covers, ms */
  blockMs: number;
}

/**
 * Capture-side health. `blocksPerSec` counts the 128-sample blocks the AudioWorklet
 * delivers (about 344/s at 44.1 kHz, 375/s at 48 kHz): if it falls to zero the microphone
 * graph stopped, which is a different failure from the bank falling behind.
 */
export interface AudioStats {
  contextState: string;
  blocksPerSec: number;
  stalled: boolean;
  secondsSinceFrame: number;
}

export const DEFAULT_BANK: BankParams = {
  bins: 100,
  octaves: 9,
  fRef: 27.5,
  q: 96,
  precision: "f32",
};

// From recept/dither_test.c at 55–3520 Hz: 0.35 bin every 12 windows separated tones 3 bins
// apart best at every pitch (contrast 0.77–1.0) at near-full brightness. Half a bin is ~12%
// brighter but separates less; periods under ~6 windows average out; deeper sweeps smear.
export const DEFAULT_DITHER: DitherParams = {
  enabled: false,
  depth: 0.35,
  windows: 12,
};

/** A sensor's slowest receptor window in seconds (bank_array: period_bandwidth / cycle_area periods). */
export function slowestWindowSeconds(q: number, hz: number): number {
  const cycleArea = 1 / (1 - Math.exp(-1));
  return 1 / (Math.pow(2, 1 / q) - 1) / cycleArea / hz;
}

export const DEFAULT_VIEW: ViewParams = {
  floor: 0,
  range: 60,
  decay: 0,
  band: 0.9,
  brightness: Brightness.Tonal,
  colour: Colour.Phase,
  position: Position.Centre,
  // recept/reassign_test.c: tones score >= 0.87 (0.94 without the micro-glissando), white noise
  // reaches 0.8 for ~1% of sensors, and two tones inside one receptor score 0.6-0.82
  confidence: 0.85,
  resolution: 800,
  labels: true,
};
