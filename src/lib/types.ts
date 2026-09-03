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

/** Brightness source: which quantity drives pixel intensity. */
export const enum Brightness {
  /** smoothed receptor magnitude */
  Amplitude = 0,
  /** recept.c "Receptor Model": tonal responses only */
  Tonal = 1,
  /** main.js variant: -energy - entropy, gated the same way */
  TonalAlt = 2,
}

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

export const DEFAULT_VIEW: ViewParams = {
  floor: 0,
  range: 60,
  decay: 0,
  band: 0.9,
  brightness: Brightness.Tonal,
  colour: Colour.Phase,
  resolution: 800,
  labels: true,
};
