// AudioWorkletProcessor that mixes the input to mono and forwards it to the main thread in
// 128-sample blocks, which relays it to mic-worker.js. The receptor bank itself runs in that
// Worker, not here: this thread has a hard real-time deadline and cannot own a Worker.
class MicForwardProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    if (n === 0) return true;

    const out = new Float32Array(n);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) out[i] += ch[i];
    }
    if (input.length > 1) {
      const g = 1 / input.length;
      for (let i = 0; i < n; i++) out[i] *= g;
    }

    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}

registerProcessor("mic-forward", MicForwardProcessor);
