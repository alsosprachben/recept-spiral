import { useCallback, useEffect, useRef, useState } from "react";
import type { BankParams, BankStats } from "./types";

export type MicState = "idle" | "starting" | "running" | "error";

export interface MicBank {
  state: MicState;
  /** human-readable configuration or error detail */
  info: string;
  sensors: number;
  start: () => Promise<void>;
  stop: () => void;
}

const FRAME_RATE = 60;
const MAG_STRIDE = 8;
const BANDWIDTH_FACTOR = 1.0;

function initMessage(params: BankParams, sampleRate: number) {
  return {
    type: "init" as const,
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

function sameParams(a: BankParams | null, b: BankParams): boolean {
  return !!a && a.bins === b.bins && a.octaves === b.octaves && a.fRef === b.fRef &&
    a.q === b.q && a.precision === b.precision;
}

/**
 * Owns the microphone → AudioWorklet → Worker(WebAssembly bank) chain.
 *
 * `params` may change while running: the worker re-initialises the bank in place and
 * keeps the same audio graph, so there is no gap in capture and no second permission
 * prompt. `onFrame` and `onReset` are held in refs, so they may be inline closures.
 */
export function useMicBank(
  params: BankParams,
  onFrame: (frame: ArrayBuffer, stats: BankStats) => void,
  onReset: () => void,
): MicBank {
  const [state, setState] = useState<MicState>("idle");
  const [info, setInfo] = useState("");
  const [sensors, setSensors] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sentRef = useRef<BankParams | null>(null);

  const onFrameRef = useRef(onFrame);
  const onResetRef = useRef(onReset);
  onFrameRef.current = onFrame;
  onResetRef.current = onReset;

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const stop = useCallback(() => {
    nodeRef.current?.disconnect();
    nodeRef.current = null;
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
    setSensors(0);
    setState("idle");
    setInfo("");
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

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      await ctx.audioWorklet.addModule("mic-worklet.js");

      const worker = new Worker("mic-worker.js");
      workerRef.current = worker;

      worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (d.type === "ready") {
          setSensors(d.sensors);
          setState("running");
          setInfo(
            `${d.sensors.toLocaleString()} sensors · ${(d.sensors * 3).toLocaleString()} receptors · ` +
            `${(d.sampleRate / 1000).toFixed(1)} kHz · ${paramsRef.current.precision}`,
          );
          onResetRef.current();
          if (!nodeRef.current && ctxRef.current && streamRef.current) {
            const src = ctxRef.current.createMediaStreamSource(streamRef.current);
            const node = new AudioWorkletNode(ctxRef.current, "mic-forward", { numberOfOutputs: 0 });
            node.port.onmessage = (e: MessageEvent) => {
              const buf = e.data as Float32Array;
              workerRef.current?.postMessage(buf, [buf.buffer]);
            };
            src.connect(node);
            nodeRef.current = node;
          }
        } else if (d.type === "frame") {
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
      worker.postMessage(initMessage(paramsRef.current, ctx.sampleRate));
    } catch (e) {
      stop();
      setState("error");
      setInfo((e as Error).message || String(e));
    }
  }, [stop]);

  // A parameter change while running re-initialises the bank in place.
  useEffect(() => {
    const worker = workerRef.current;
    const ctx = ctxRef.current;
    if (!worker || !ctx) return;
    if (sameParams(sentRef.current, params)) return;
    sentRef.current = { ...params };
    setInfo("reconfiguring…");
    onResetRef.current();
    worker.postMessage(initMessage(params, ctx.sampleRate));
  }, [params]);

  useEffect(() => stop, [stop]);

  return { state, info, sensors, start, stop };
}
