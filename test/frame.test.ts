/**
 * The detected-frequency (reassigned) packing: lit sensors move to their detected frequency on a
 * grid REASSIGN_FACTOR times finer, split between the two nearest cells, summed, and wrapping
 * into the next octave's row; sensors below the confidence threshold stay at their centre.
 */
import { describe, expect, test } from "bun:test";
import { gridWidth, packBuffers, packPixels, parseHeader } from "../src/lib/frame";
import { Brightness, Colour, DEFAULT_VIEW, Position, REASSIGN_FACTOR } from "../src/lib/types";
import type { ViewParams } from "../src/lib/types";

const BINS = 10;
const OCTAVES = 2;
const SENSORS = BINS * OCTAVES;
const CHANNELS = 7;
const BIN_CENTS = 1200 / BINS;

/** An RCP1 frame whose sensors are dark except those given: [sensor, amplitude, cents, confidence]. */
function frame(lit: [number, number, number, number][]): ArrayBuffer {
  const header = 48;
  const ab = new ArrayBuffer(header + SENSORS * CHANNELS * 4);
  const dv = new DataView(ab);
  dv.setUint32(0, 0x31504352, true);
  dv.setUint32(4, header, true);
  dv.setUint32(16, 44100, true);
  dv.setUint32(20, BINS, true);
  dv.setUint32(24, OCTAVES, true);
  dv.setUint32(28, SENSORS, true);
  dv.setUint32(32, CHANNELS, true);
  dv.setFloat32(36, 27.5, true);
  const data = new Float32Array(ab, header, SENSORS * CHANNELS);
  for (const [i, amp, cents, conf] of lit) {
    data[i * CHANNELS] = amp;
    data[i * CHANNELS + 5] = cents;
    data[i * CHANNELS + 6] = conf;
  }
  return ab;
}

const view: ViewParams = {
  ...DEFAULT_VIEW,
  brightness: Brightness.Amplitude,
  colour: Colour.Amplitude,
  position: Position.Detected,
  confidence: 0.85,
  floor: -20,
  range: 100,
  decay: 0,
};

function pack(ab: ArrayBuffer): Uint8Array {
  const meta = parseHeader(ab)!;
  const W = gridWidth(meta, view);
  expect(W).toBe(BINS * REASSIGN_FACTOR);
  const pixels = new Uint8Array(W * OCTAVES * 4);
  packPixels(ab, meta, view, packBuffers(W * OCTAVES), pixels);
  return pixels;
}

/** cells with any brightness */
function lit(pixels: Uint8Array): number[] {
  const out: number[] = [];
  for (let j = 0; j < pixels.length / 4; j++) if (pixels[j * 4] > 0) out.push(j);
  return out;
}

describe("detected-frequency packing", () => {
  test("two sensors reporting the same frequency collapse onto one place", () => {
    // sensors 5 and 6 both say "5.5 bins": fine position 22, i.e. cells 21 and 22 equally
    const px = pack(frame([[5, 1000, BIN_CENTS / 2, 1], [6, 1000, -BIN_CENTS / 2, 1]]));
    expect(lit(px)).toEqual([21, 22]);
    expect(px[21 * 4]).toBe(px[22 * 4]);
  });

  test("a deposit past the end of a row continues in the next octave's row", () => {
    // sensor 9 at 9.9 bins: fine position 39.6 -> cells 39 (row 0's last) and 40 (row 1's first)
    const px = pack(frame([[9, 1000, 0.9 * BIN_CENTS, 1]]));
    expect(lit(px)).toEqual([39, 40]);
  });

  test("below the confidence threshold a sensor stays at its centre", () => {
    const px = pack(frame([[15, 1000, BIN_CENTS / 2, 0.5]]));
    // centre of sensor 15 = fine position 60 -> cells 59 and 60 equally
    expect(lit(px)).toEqual([59, 60]);
  });

  test("centre mode is one texel per sensor, as before", () => {
    const ab = frame([[3, 1000, BIN_CENTS / 2, 1]]);
    const meta = parseHeader(ab)!;
    const centre = { ...view, position: Position.Centre };
    expect(gridWidth(meta, centre)).toBe(BINS);
    const pixels = new Uint8Array(BINS * OCTAVES * 4);
    packPixels(ab, meta, centre, packBuffers(BINS * OCTAVES), pixels);
    expect(lit(pixels)).toEqual([3]);
  });
});
