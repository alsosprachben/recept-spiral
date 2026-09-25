import type { FrameMeta, ViewParams } from "./types";
import { Brightness, Position, REASSIGN_FACTOR } from "./types";

const MAGIC = 0x31504352; // "RCP1" little-endian

/**
 * Parse an RCP1 frame header. Returns null if the buffer is not a frame.
 *
 * Layout (little-endian, see bank_wasm.c):
 *   0  char[4] magic "RCP1"
 *   4  u32     header_size (48: the C struct is padded to 8-byte alignment)
 *   8  f64     time
 *   16 u32     sample_rate
 *   20 u32     bins_per_octave
 *   24 u32     octaves
 *   28 u32     sensors
 *   32 u32     channels
 *   36 f32     f_ref
 *   40 u32     stamp_ms
 */
export function parseHeader(ab: ArrayBuffer): FrameMeta | null {
  if (ab.byteLength < 48) return null;
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== MAGIC) return null;
  const headerSize = dv.getUint32(4, true);
  const meta: FrameMeta = {
    time: dv.getFloat64(8, true),
    sampleRate: dv.getUint32(16, true),
    bins: dv.getUint32(20, true),
    octaves: dv.getUint32(24, true),
    sensors: dv.getUint32(28, true),
    channels: dv.getUint32(32, true),
    fRef: dv.getFloat32(36, true),
    stamp: dv.getUint32(40, true),
    headerSize,
  };
  if (ab.byteLength < headerSize + meta.sensors * meta.channels * 4) return null;
  return meta;
}

/** Channels 5 and 6 (detected frequency, confidence) exist from this channel count on. */
const REASSIGN_CHANNELS = 7;

/** Whether this frame is drawn reassigned: asked for, and the producer sends the channels. */
export function isDetected(meta: FrameMeta, view: ViewParams): boolean {
  return view.position === Position.Detected && meta.channels >= REASSIGN_CHANNELS;
}

/** Texture width (cells per octave row) for this frame and view. */
export function gridWidth(meta: FrameMeta, view: ViewParams): number {
  return isDetected(meta, view) ? meta.bins * REASSIGN_FACTOR : meta.bins;
}

/**
 * Where cell j of a row sits, in cells: centre-mode texel i holds sensor i, whose frequency is at
 * i / bins; detected-mode deposits are placed so that cell j represents (j + 0.5) / width.
 */
export function cellOffset(meta: FrameMeta, view: ViewParams): number {
  return isDetected(meta, view) ? 0.5 : 0;
}

/** Scratch buffers for packPixels, sized octaves * gridWidth. */
export interface PackBuffers {
  /** visual persistence per cell, carried between frames */
  held: Float32Array;
  /** detected mode: summed linear brightness per cell */
  acc: Float32Array;
  /** detected mode: the strongest single contribution per cell (it supplies the colour) */
  best: Float32Array;
}

export function packBuffers(cells: number): PackBuffers {
  return { held: new Float32Array(cells), acc: new Float32Array(cells), best: new Float32Array(cells) };
}

/**
 * Turn one frame into the RGBA texture the spiral samples, gridWidth(meta, view) cells per
 * octave row:
 *
 *   R  brightness 0..1 (after the dB window and the visual persistence)
 *   G  lifecycle phase, [-0.5, 0.5) mapped to 0..1
 *   B  onset strength  (free energy negative)
 *   A  decay strength  (free energy positive)
 *
 * Centre mode: one texel per sensor. Detected mode: each lit sensor whose confidence clears
 * view.confidence moves to its detected frequency (channel 5, cents from its centre) on a grid
 * REASSIGN_FACTOR times finer, split linearly between the two nearest cells; brightness is summed
 * (a tone that lit several sensors collapses into one line) and the colour comes from the
 * strongest contributor, since phase cannot be averaged.
 */
export function packPixels(
  ab: ArrayBuffer,
  meta: FrameMeta,
  view: ViewParams,
  buf: PackBuffers,
  pixels: Uint8Array,
): void {
  const data = new Float32Array(ab, meta.headerSize, meta.sensors * meta.channels);
  const C = meta.channels;
  const { floor, range, decay, brightness } = view;
  const detected = isDetected(meta, view);
  const R = detected ? REASSIGN_FACTOR : 1;
  const cells = meta.bins * R * meta.octaves;
  const { held, acc, best } = buf;
  const binCents = 1200 / meta.bins;

  if (detected) {
    acc.fill(0, 0, cells);
    best.fill(0, 0, cells);
    pixels.fill(0, 0, cells * 4);
  }

  for (let i = 0; i < meta.sensors; i++) {
    const base = i * C;
    const r = data[base];
    const F = data[base + 1];
    const entropy = data[base + 2];
    const energy = data[base + 3];
    const phi = data[base + 4];

    // Brightness source. The "receptor model" variants cull non-tonal responses:
    // lifecycle energy is the second difference of magnitude across the three
    // scales, so it is negative only where the response peaks — a tonal ridge.
    let p: number;
    if (brightness === Brightness.Tonal) {
      p = energy < 0 ? Math.hypot(energy, F) : 0;
    } else if (brightness === Brightness.TonalAlt) {
      p = energy < 0 ? Math.max(0, -energy - entropy) : 0;
    } else {
      p = r;
    }

    const fmag = Math.min(1, Math.abs(F) / (r + 1e-9));
    const g = (phi + 0.5) * 255;
    const onset = (F < 0 ? fmag : 0) * 255;
    const decayC = (F > 0 ? fmag : 0) * 255;

    if (!detected) {
      pixels[i * 4] = level(p, i);
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = onset;
      pixels[i * 4 + 3] = decayC;
      continue;
    }
    if (!(p > 0)) continue;

    const cents = data[base + 5];
    const conf = data[base + 6];
    const x = i + (conf >= view.confidence && Number.isFinite(cents) ? cents / binCents : 0);
    const u = x * R - 0.5;
    const j0 = Math.floor(u);
    const w1 = u - j0;
    for (let k = 0; k < 2; k++) {
      const j = j0 + k;
      if (j < 0 || j >= cells) continue;
      const e = p * (k === 0 ? 1 - w1 : w1);
      acc[j] += e;
      if (e > best[j]) {
        best[j] = e;
        pixels[j * 4 + 1] = g;
        pixels[j * 4 + 2] = onset;
        pixels[j * 4 + 3] = decayC;
      }
    }
  }

  if (detected) {
    for (let j = 0; j < cells; j++) pixels[j * 4] = level(acc[j], j);
  }

  /** dB window and visual persistence for one cell; returns the R byte */
  function level(p: number, j: number): number {
    const db = 20 * Math.log10(p + 1e-9);
    let v = (db - floor) / range;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const h = held[j] * decay;
    if (h > v) v = h;
    held[j] = v;
    return v * 255;
  }
}

/** Frequency of sensor i. */
export function sensorFrequency(meta: FrameMeta, i: number): number {
  return meta.fRef * Math.pow(2, i / meta.bins);
}
