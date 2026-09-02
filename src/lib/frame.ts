import type { FrameMeta, ViewParams } from "./types";
import { Brightness } from "./types";

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

/**
 * Turn one frame into the RGBA texture the spiral samples, one texel per sensor:
 *
 *   R  brightness 0..1 (after the dB window and the visual persistence)
 *   G  lifecycle phase, [-0.5, 0.5) mapped to 0..1
 *   B  onset strength  (free energy negative)
 *   A  decay strength  (free energy positive)
 *
 * `held` carries the persistence between frames and must be sensors long;
 * `pixels` must be sensors * 4 long.
 */
export function packPixels(
  ab: ArrayBuffer,
  meta: FrameMeta,
  view: ViewParams,
  held: Float32Array,
  pixels: Uint8Array,
): void {
  const data = new Float32Array(ab, meta.headerSize, meta.sensors * meta.channels);
  const C = meta.channels;
  const { floor, range, decay, brightness } = view;

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

    const db = 20 * Math.log10(p + 1e-9);
    let v = (db - floor) / range;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const h = held[i] * decay;
    if (h > v) v = h;
    held[i] = v;

    const fmag = Math.min(1, Math.abs(F) / (r + 1e-9));
    const o = i * 4;
    pixels[o] = v * 255;
    pixels[o + 1] = (phi + 0.5) * 255;
    pixels[o + 2] = (F < 0 ? fmag : 0) * 255;
    pixels[o + 3] = (F > 0 ? fmag : 0) * 255;
  }
}

/** Frequency of sensor i. */
export function sensorFrequency(meta: FrameMeta, i: number): number {
  return meta.fRef * Math.pow(2, i / meta.bins);
}
