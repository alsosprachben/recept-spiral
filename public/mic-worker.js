// Web Worker running the receptor bank (bank.wasm / bank_f32.wasm, compiled from the C in
// wasm/) on microphone audio forwarded by mic-worklet.js. It emits RCP1 frames — the same
// binary layout bank_stream.c produces natively — which the page turns into the spiral.
//
// The bank runs here rather than in the AudioWorklet because that thread has a hard
// per-block deadline: overrunning there is an audio glitch, while falling behind here
// only costs display frames.
//
// Messages in:  {type:'init', sampleRate, bins, octaves, fRef, q, frameRate, stride,
//                bandwidth, precision:'f32'|'f64'}
//               Float32Array — one audio block, nominally +-1
//               {type:'stop'}
// Messages out: {type:'ready', sensors, block, sampleRate}
//               {type:'frame', frame: ArrayBuffer, processMs, blockMs}
//               {type:'error', message}

let wasm = null;
let mem = null;
let wasmFile = "";
let ready = false;
let inputPtr = 0;
let inputCap = 0;
let block = 0;
let sampleRate = 44100;

let procMs = 0;  // smoothed wasm time per produced frame
let accumMs = 0; // time spent since the last produced frame

async function load(file) {
  const resp = await fetch(file);
  if (!resp.ok) throw new Error(`fetch ${file}: HTTP ${resp.status}`);
  const bytes = await resp.arrayBuffer();
  const imports = {
    env: {
      emscripten_notify_memory_growth: () => {
        mem = new Uint8Array(wasm.exports.memory.buffer);
      },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  wasm = instance;
  wasmFile = file;
  mem = new Uint8Array(wasm.exports.memory.buffer);
  if (wasm.exports._initialize) wasm.exports._initialize();
}

function refreshMem() {
  if (!mem || mem.buffer !== wasm.exports.memory.buffer) {
    mem = new Uint8Array(wasm.exports.memory.buffer);
  }
}

function ensureInput(n) {
  if (n > inputCap) {
    const want = Math.max(n, 4096);
    inputPtr = wasm.exports.bank_wasm_input(want);
    if (!inputPtr) throw new Error("bank_wasm_input: out of memory");
    inputCap = want;
    refreshMem();
  }
}

function handleAudio(samples) {
  if (!ready) return;
  const n = samples.length;
  ensureInput(n);

  // scale to the amplitude the bank was calibrated at (recept_test feeds +-1 times 10000)
  const view = new Float32Array(wasm.exports.memory.buffer, inputPtr, n);
  for (let i = 0; i < n; i++) view[i] = samples[i] * 10000;

  const t0 = performance.now();
  const produced = wasm.exports.bank_wasm_process(n, (Date.now() % 4294967296) >>> 0);
  accumMs += performance.now() - t0;

  if (produced > 0) {
    refreshMem();
    const ptr = wasm.exports.bank_wasm_frame();
    const size = wasm.exports.bank_wasm_frame_size();
    const frame = mem.slice(ptr, ptr + size).buffer;
    procMs = procMs === 0 ? accumMs : 0.9 * procMs + 0.1 * accumMs;
    accumMs = 0;
    postMessage(
      { type: "frame", frame, processMs: procMs, blockMs: (1000 * block) / sampleRate },
      [frame],
    );
  }
}

async function handleInit(d) {
  const file = d.precision === "f64" ? "bank.wasm" : "bank_f32.wasm";
  if (!wasm || wasmFile !== file) await load(file);
  sampleRate = d.sampleRate;
  const sensors = wasm.exports.bank_wasm_init(
    d.sampleRate, d.bins, d.octaves, d.fRef, d.q, d.frameRate, d.stride, d.bandwidth,
  );
  if (sensors < 0) throw new Error("bank_wasm_init failed (out of memory?)");
  block = wasm.exports.bank_wasm_block();
  inputCap = 0;
  ensureInput(4096);
  ready = true;
  procMs = 0;
  accumMs = 0;
  postMessage({ type: "ready", sensors, block, sampleRate });
}

onmessage = async (ev) => {
  const d = ev.data;
  try {
    if (d instanceof Float32Array) {
      handleAudio(d);
    } else if (d && d.type === "init") {
      await handleInit(d);
    } else if (d && d.type === "stop") {
      ready = false;
      if (wasm) wasm.exports.bank_wasm_free();
      inputCap = 0;
    }
  } catch (e) {
    ready = false;
    postMessage({ type: "error", message: String((e && e.message) || e) });
  }
};
