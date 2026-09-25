import { useCallback, useEffect, useRef, useState } from "react";
import { versionedAsset } from "./assets";
import type { AudioStats, BankParams, BankStats, DitherParams } from "./types";

export type MicState = "idle" | "starting" | "running" | "error";

export interface MicBank {
  state: MicState;
  /** human-readable configuration or error detail */
  info: string;
  sensors: number;
  audio: AudioStats;
  start: () => Promise<void>;
  stop: () => void;
}

const FRAME_RATE = 60;
const MAG_STRIDE = 8;
const BANDWIDTH_FACTOR = 1.0;
/** no frames for this long while running counts as a stall */
const STALL_MS = 2000;

const WORKLET_URL = versionedAsset("mic-worklet.js", __BUILD_ID__);
const WORKER_URL = versionedAsset("mic-worker.js", __BUILD_ID__);

function initMessage(params: BankParams, sampleRate: number) {
  return {
    type: "init" as const,
    // resolved here so the worker never has to know the naming scheme
    wasmFile: versionedAsset(
      params.precision === "f64" ? "bank.wasm" : "bank_f32.wasm",
      __BUILD_ID__,
    ),
    sampleRate,
    bins: params.bins,
    octaves: params.octaves,
    fRef: params.fRef,
    q: params.q,
    frameRate: FRAME_RATE,
    stride: MAG_STRIDE,
    bandwidth: BANDWIDTH_FACTOR,
    precision: params.precision,
  };
}

/** The depth is a fraction of the bin spacing, so it follows the (auto-scaled) bin count. */
function ditherMessage(d: DitherParams, bins: number) {
  return {
    type: "dither" as const,
    cents: d.enabled ? (d.depth * 1200) / bins : 0,
    windows: d.windows,
  };
}

function sameParams(a: BankParams | null, b: BankParams): boolean {
  return !!a && a.bins === b.bins && a.octaves === b.octaves && a.fRef === b.fRef &&
    a.q === b.q && a.precision === b.precision;
}

const IDLE_AUDIO: AudioStats = {
  contextState: "closed",
  blocksPerSec: 0,
  stalled: false,
  secondsSinceFrame: 0,
};

/**
 * Owns the microphone → AudioWorklet → Worker(WebAssembly bank) chain.
 *
 * Two lifetime rules matter here, and getting either wrong stops capture after a few
 * seconds on mobile while looking fine on desktop:
 *
 *  1. Every node must stay strongly referenced. A MediaStreamAudioSourceNode held only by
 *     a local variable is collected once the function returns, and audio silently stops.
 *  2. The graph must reach ctx.destination, because rendering is pulled from there. The
 *     worklet's silent output therefore runs through a zero-gain node to the destination —
 *     zero gain so the microphone is never fed back to the speaker.
 *
 * `params` may change while running: the worker re-initialises the bank in place and keeps
 * the same audio graph, so there is no gap in capture and no second permission prompt.
 */
export function useMicBank(
  params: BankParams,
  dither: DitherParams,
  onFrame: (frame: ArrayBuffer, stats: BankStats) => void,
  onReset: () => void,
): MicBank {
  const [state, setState] = useState<MicState>("idle");
  const [info, setInfo] = useState("");
  const [sensors, setSensors] = useState(0);
  const [audio, setAudio] = useState<AudioStats>(IDLE_AUDIO);

  const ctxRef = useRef<AudioContext | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  // held so the browser cannot collect them mid-session — see the note above
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sentRef = useRef<BankParams | null>(null);

  const blocksRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const runningRef = useRef(false);

  const onFrameRef = useRef(onFrame);
  const onResetRef = useRef(onReset);
  onFrameRef.current = onFrame;
  onResetRef.current = onReset;

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const ditherRef = useRef(dither);
  ditherRef.current = dither;

  const stop = useCallback(() => {
    runningRef.current = false;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    srcRef.current?.disconnect();
    srcRef.current = null;
    sinkRef.current?.disconnect();
    sinkRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "stop" });
      workerRef.current.terminate();
      workerRef.current = null;
    }
    sentRef.current = null;
    blocksRef.current = 0;
    lastFrameAtRef.current = 0;
    setSensors(0);
    setState("idle");
    setInfo("");
    setAudio(IDLE_AUDIO);
  }, []);

  const buildGraph = useCallback(() => {
    const ctx = ctxRef.current;
    const stream = streamRef.current;
    if (!ctx || !stream || nodeRef.current) return;

    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "mic-forward", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // zero gain: the graph reaches the destination so it is pulled, but nothing is audible
    // and the microphone cannot feed back into the speaker
    const sink = ctx.createGain();
    sink.gain.value = 0;

    node.port.onmessage = (e: MessageEvent) => {
      const buf = e.data as Float32Array;
      blocksRef.current++;
      workerRef.current?.postMessage(buf, [buf.buffer]);
    };

    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    srcRef.current = src;
    nodeRef.current = node;
    sinkRef.current = sink;
  }, []);

  const start = useCallback(async () => {
    stop();
    setState("starting");
    setInfo("requesting microphone…");
    try {
      // the bank wants the signal as captured: browser voice processing would fight it
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      // the OS can end the track (another app takes the mic, a call arrives)
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (!runningRef.current) return;
          setState("error");
          setInfo("the microphone track ended — another app may have taken the microphone");
        });
      }

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      ctx.onstatechange = () => {
        if (!runningRef.current) return;
        // iOS suspends (and reports "interrupted") on calls, route changes and backgrounding
        if (ctx.state !== "running") void ctx.resume().catch(() => {});
      };
      if (ctx.state !== "running") await ctx.resume();
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
      } catch (e) {
        // A static host that answers unknown paths with the SPA shell turns a missing
        // asset into a syntax error from parsing HTML as JavaScript. Say so plainly.
        throw new Error(
          `could not load ${WORKLET_URL} — the server may have returned index.html ` +
          `instead of JavaScript (${(e as Error).message})`,
        );
      }

      const worker = new Worker(WORKER_URL);
      workerRef.current = worker;

      worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (d.type === "ready") {
          setSensors(d.sensors);
          setState("running");
          runningRef.current = true;
          lastFrameAtRef.current = performance.now();
          setInfo(
            `${d.sensors.toLocaleString()} sensors · ${(d.sensors * 3).toLocaleString()} receptors · ` +
            `${(d.sampleRate / 1000).toFixed(1)} kHz · ${paramsRef.current.precision}`,
          );
          onResetRef.current();
          buildGraph();
        } else if (d.type === "frame") {
          lastFrameAtRef.current = performance.now();
          onFrameRef.current(d.frame as ArrayBuffer, { procMs: d.processMs, blockMs: d.blockMs });
        } else if (d.type === "error") {
          setState("error");
          setInfo(d.message);
        }
      };
      worker.onerror = (e) => {
        setState("error");
        setInfo(e.message || "worker failed to load");
      };

      sentRef.current = { ...paramsRef.current };
      worker.postMessage(ditherMessage(ditherRef.current, paramsRef.current.bins));
      worker.postMessage(initMessage(paramsRef.current, ctx.sampleRate));
    } catch (e) {
      stop();
      setState("error");
      setInfo((e as Error).message || String(e));
    }
  }, [stop, buildGraph]);

  // A parameter change while running re-initialises the bank in place.
  useEffect(() => {
    const worker = workerRef.current;
    const ctx = ctxRef.current;
    if (!worker || !ctx) return;
    if (sameParams(sentRef.current, params)) return;
    sentRef.current = { ...params };
    setInfo("reconfiguring…");
    onResetRef.current();
    worker.postMessage(ditherMessage(ditherRef.current, params.bins));
    worker.postMessage(initMessage(params, ctx.sampleRate));
  }, [params]);

  // The dither is applied live; the worker keeps it across re-inits.
  useEffect(() => {
    workerRef.current?.postMessage(ditherMessage(dither, paramsRef.current.bins));
  }, [dither.enabled, dither.depth, dither.windows]);

  // Once a second: report the audio-side counters and notice a stall. Counting the blocks
  // the worklet delivers separates "capture stopped" from "the bank stopped keeping up".
  useEffect(() => {
    if (state !== "running") return;
    let lastBlocks = blocksRef.current;
    let lastAt = performance.now();

    const timer = window.setInterval(() => {
      const now = performance.now();
      const ctx = ctxRef.current;
      const blocksPerSec = ((blocksRef.current - lastBlocks) * 1000) / (now - lastAt);
      lastBlocks = blocksRef.current;
      lastAt = now;

      const since = lastFrameAtRef.current ? now - lastFrameAtRef.current : 0;
      const stalled = since > STALL_MS;
      if (stalled && ctx && ctx.state !== "running") void ctx.resume().catch(() => {});

      setAudio({
        contextState: ctx?.state ?? "closed",
        blocksPerSec,
        stalled,
        secondsSinceFrame: since / 1000,
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [state]);

  // Coming back to the tab on mobile usually finds the context suspended.
  useEffect(() => {
    const onVisible = () => {
      if (!runningRef.current || document.visibilityState !== "visible") return;
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => stop, [stop]);

  return { state, info, sensors, audio, start, stop };
}
