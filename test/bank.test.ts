/**
 * Smoke test of the committed WebAssembly banks: instantiate, run a known tone through the
 * bank, and check the frames it produces are well-formed and point at the right sensor.
 *
 * This is the artifact the browser actually loads, so it catches a stale or truncated .wasm
 * — the one failure the TypeScript build cannot see. Suitable as DataVec's SITE_TEST_CMD.
 */
import { describe, expect, test } from "bun:test";

const SAMPLE_RATE = 44100;
const BINS = 100;
const OCTAVES = 9;
const F_REF = 27.5;
const Q = 96;
const FRAME_RATE = 60;
const CHANNELS = 5;

interface BankExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  bank_wasm_init: (
    sr: number, bins: number, octaves: number, fRef: number,
    q: number, frameRate: number, stride: number, bandwidth: number,
  ) => number;
  bank_wasm_input: (n: number) => number;
  bank_wasm_process: (n: number, stamp: number) => number;
  bank_wasm_frame: () => number;
  bank_wasm_frame_size: () => number;
  bank_wasm_block: () => number;
  bank_wasm_free: () => void;
}

async function instantiate(file: string): Promise<BankExports> {
  const bytes = await Bun.file(`public/${file}`).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const ex = instance.exports as unknown as BankExports;
  ex._initialize?.();
  return ex;
}

/** Run `seconds` of a sine through the bank in 128-sample blocks; return the frames. */
function runTone(ex: BankExports, freq: number, seconds: number): ArrayBuffer[] {
  const sensors = ex.bank_wasm_init(SAMPLE_RATE, BINS, OCTAVES, F_REF, Q, FRAME_RATE, 8, 1.0);
  expect(sensors).toBe(BINS * OCTAVES);

  const chunk = 128;
  const ptr = ex.bank_wasm_input(chunk);
  expect(ptr).toBeGreaterThan(0);

  const frames: ArrayBuffer[] = [];
  const total = Math.floor(SAMPLE_RATE * seconds);
  for (let off = 0; off < total; off += chunk) {
    const n = Math.min(chunk, total - off);
    const view = new Float32Array(ex.memory.buffer, ptr, n);
    for (let i = 0; i < n; i++) {
      view[i] = Math.sin((2 * Math.PI * freq * (off + i)) / SAMPLE_RATE) * 10000;
    }
    if (ex.bank_wasm_process(n, 0) > 0) {
      const fp = ex.bank_wasm_frame();
      const size = ex.bank_wasm_frame_size();
      frames.push(ex.memory.buffer.slice(fp, fp + size));
    }
  }
  return frames;
}

function parse(frame: ArrayBuffer) {
  const dv = new DataView(frame);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  return {
    magic,
    headerSize: dv.getUint32(4, true),
    sampleRate: dv.getUint32(16, true),
    bins: dv.getUint32(20, true),
    octaves: dv.getUint32(24, true),
    sensors: dv.getUint32(28, true),
    channels: dv.getUint32(32, true),
    fRef: dv.getFloat32(36, true),
  };
}

for (const file of ["bank_f32.wasm", "bank.wasm"]) {
  describe(file, () => {
    test("produces one well-formed frame per 1/60 s of audio", async () => {
      const ex = await instantiate(file);
      const frames = runTone(ex, 440, 2);

      // 60 frames a second, give or take the trailing partial block
      expect(frames.length).toBeGreaterThanOrEqual(118);
      expect(frames.length).toBeLessThanOrEqual(121);

      const h = parse(frames[frames.length - 1]);
      expect(h.magic).toBe("RCP1");
      expect(h.sensors).toBe(BINS * OCTAVES);
      expect(h.channels).toBe(CHANNELS);
      expect(h.bins).toBe(BINS);
      expect(h.octaves).toBe(OCTAVES);
      expect(h.sampleRate).toBe(SAMPLE_RATE);
      expect(h.fRef).toBeCloseTo(F_REF, 3);
      expect(frames[frames.length - 1].byteLength).toBe(h.headerSize + h.sensors * h.channels * 4);

      ex.bank_wasm_free();
    });

    test("puts a 440 Hz tone on the 440 Hz sensor", async () => {
      const ex = await instantiate(file);
      const frames = runTone(ex, 440, 2);
      const last = frames[frames.length - 1];
      const h = parse(last);
      const data = new Float32Array(last, h.headerSize, h.sensors * h.channels);

      let peak = -Infinity;
      let peakIndex = -1;
      for (let i = 0; i < h.sensors; i++) {
        const amp = data[i * h.channels];
        expect(Number.isFinite(amp)).toBe(true);
        if (amp > peak) {
          peak = amp;
          peakIndex = i;
        }
      }

      // log2(440 / 27.5) = 4 exactly, so the tone sits on sensor 4 * BINS
      const expected = 4 * BINS;
      expect(Math.abs(peakIndex - expected)).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(0);

      const peakFreq = h.fRef * Math.pow(2, peakIndex / h.bins);
      expect(peakFreq).toBeGreaterThan(430);
      expect(peakFreq).toBeLessThan(450);

      ex.bank_wasm_free();
    });
  });
}
