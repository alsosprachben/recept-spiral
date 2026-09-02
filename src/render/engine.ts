import { packPixels, parseHeader } from "../lib/frame";
import type { FrameMeta, RenderStats, ViewParams } from "../lib/types";
import { Colour } from "../lib/types";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** inner radius as a fraction of the disc radius */
const R0 = 0.12;

interface Geometry {
  w: number;
  h: number;
  /** disc radius in pixels */
  disc: number;
  r0: number;
  /** radial fraction per octave */
  k: number;
}

/**
 * The spiral renderer: framework-free so it can own its own animation frame loop
 * and mutable per-frame state without fighting React's render cycle.
 *
 * WebGL2 draws the whole disc in one fragment-shader pass from a sensors-wide
 * texture. Where WebGL2 is unavailable (or is software-rasterised and slow), the
 * canvas2d fallback strokes one short arc per sensor instead.
 */
export class SpiralEngine {
  readonly backend: "webgl2" | "canvas2d";

  private glCanvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private view: ViewParams;

  private gl: WebGL2RenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private tex: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private meta: FrameMeta | null = null;
  private held: Float32Array | null = null;
  private pixels: Uint8Array | null = null;
  private dirty = false;

  private raf = 0;
  private frames = 0;
  private lastFrames = 0;
  private draws = 0;
  private lastDraws = 0;
  private lastTick = 0;
  private fps = 0;
  private drawFps = 0;
  private drawMs = 0;
  private error = "";

  constructor(
    glCanvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    view: ViewParams,
    preferCanvas2d = false,
  ) {
    this.glCanvas = glCanvas;
    this.overlay = overlay;
    this.view = view;

    if (!preferCanvas2d) {
      try {
        this.gl = glCanvas.getContext("webgl2", { antialias: false });
      } catch {
        this.gl = null;
      }
    }
    if (this.gl) {
      try {
        this.setupGL(this.gl);
      } catch (e) {
        this.error = `WebGL setup failed, using canvas2d: ${(e as Error).message}`;
        this.gl = null;
      }
    }
    if (!this.gl) {
      this.ctx2d = glCanvas.getContext("2d");
    }
    this.backend = this.gl ? "webgl2" : "canvas2d";
  }

  private setupGL(gl: WebGL2RenderingContext): void {
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
      }
      return s;
    };

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const n of ["tex", "aspect", "r0", "k", "octaves", "band", "mode"]) {
      this.uniforms[n] = gl.getUniformLocation(prog, n);
    }

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // the pitch class wraps around the disc; octaves do not
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  setView(view: ViewParams): void {
    const labelsChanged = view.labels !== this.view.labels;
    this.view = view;
    this.dirty = true;
    if (labelsChanged && this.meta) this.drawOverlay(this.meta);
  }

  /** Feed one RCP1 frame. Safe to call from a worker message handler. */
  ingest(ab: ArrayBuffer): void {
    try {
      const m = parseHeader(ab);
      if (!m) return;

      if (!this.meta || this.meta.bins !== m.bins || this.meta.octaves !== m.octaves ||
          this.meta.sensors !== m.sensors) {
        this.held = new Float32Array(m.sensors);
        this.pixels = new Uint8Array(m.bins * m.octaves * 4);
        if (this.gl && this.tex) {
          this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
          this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, m.bins, m.octaves, 0,
            this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        }
        this.meta = m;
        this.drawOverlay(m);
      }
      this.meta = m;

      packPixels(ab, m, this.view, this.held!, this.pixels!);

      if (this.gl && this.tex) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, m.bins, m.octaves,
          this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixels!);
      }
      this.frames++;
      this.dirty = true;
    } catch (e) {
      this.error = `ingest: ${(e as Error).message}`;
    }
  }

  start(): void {
    if (this.raf) return;
    this.lastTick = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Drop the frame state so a reconfigured bank starts from a clean display. */
  reset(): void {
    this.meta = null;
    this.held = null;
    this.pixels = null;
    this.dirty = false;
    const c = this.overlay.getContext("2d");
    c?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.gl) {
      this.gl.clearColor(0, 0, 0, 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    } else if (this.ctx2d) {
      this.ctx2d.fillStyle = "#000";
      this.ctx2d.fillRect(0, 0, this.glCanvas.width, this.glCanvas.height);
    }
  }

  getStats(): RenderStats {
    return {
      backend: this.backend,
      meta: this.meta,
      fps: this.fps,
      drawFps: this.drawFps,
      drawMs: this.drawMs,
      canvasWidth: this.glCanvas.width,
      canvasHeight: this.glCanvas.height,
      error: this.error,
    };
  }

  private tick(): void {
    this.resize();
    if (this.dirty && this.meta) {
      const t0 = performance.now();
      if (this.gl) this.renderGL();
      else this.render2d();
      this.drawMs = this.drawMs === 0
        ? performance.now() - t0
        : 0.9 * this.drawMs + 0.1 * (performance.now() - t0);
      this.draws++;
      this.dirty = false;
    }
    const t = performance.now();
    if (t - this.lastTick > 1000) {
      const dt = t - this.lastTick;
      this.fps = ((this.frames - this.lastFrames) * 1000) / dt;
      this.drawFps = ((this.draws - this.lastDraws) * 1000) / dt;
      this.lastFrames = this.frames;
      this.lastDraws = this.draws;
      this.lastTick = t;
    }
  }

  private resize(): void {
    const cw = this.glCanvas.clientWidth;
    const ch = this.glCanvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    // The backing store is `resolution` px on the short side and CSS scales it to the
    // window: a fragment-shader disc costs pixels, so this is the main render-cost knob.
    const scale = this.view.resolution / Math.max(1, Math.min(cw, ch));
    const w = Math.round(cw * scale);
    const h = Math.round(ch * scale);
    if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
      this.glCanvas.width = w;
      this.glCanvas.height = h;
      this.overlay.width = w;
      this.overlay.height = h;
      this.gl?.viewport(0, 0, w, h);
      if (this.meta) this.drawOverlay(this.meta);
      this.dirty = true;
    }
  }

  private geometry(): Geometry {
    const w = this.glCanvas.width;
    const h = this.glCanvas.height;
    const disc = Math.min(w, h) * 0.5 * 0.96;
    return { w, h, disc, r0: R0, k: (1 - R0) / (this.meta ? this.meta.octaves : 1) };
  }

  private renderGL(): void {
    const gl = this.gl!;
    const g = this.geometry();
    gl.uniform1i(this.uniforms.tex!, 0);
    gl.uniform2f(this.uniforms.aspect!, g.w / 2 / g.disc, g.h / 2 / g.disc);
    gl.uniform1f(this.uniforms.r0!, g.r0);
    gl.uniform1f(this.uniforms.k!, g.k);
    gl.uniform1f(this.uniforms.octaves!, this.meta!.octaves);
    gl.uniform1f(this.uniforms.band!, this.view.band);
    gl.uniform1i(this.uniforms.mode!, this.view.colour);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // include rasterisation in the timing: software GL shows up here, not later
    gl.finish();
  }

  private render2d(): void {
    const c = this.ctx2d!;
    const meta = this.meta!;
    const pixels = this.pixels!;
    const g = this.geometry();
    const cx = g.w / 2;
    const cy = g.h / 2;
    const mode = this.view.colour;

    c.fillStyle = "#000";
    c.fillRect(0, 0, g.w, g.h);
    c.lineWidth = Math.max(1, g.disc * g.k * 0.5 * this.view.band);
    const step = (Math.PI * 2) / meta.bins;

    for (let i = 0; i < meta.sensors; i++) {
      const o = i * 4;
      const amp = pixels[o] / 255;
      if (amp < 0.02 && mode !== Colour.FreeEnergy) continue;

      const octave = Math.floor(i / meta.bins);
      const pos = i % meta.bins;
      const s0 = octave + pos / meta.bins;
      const s1 = octave + (pos + 1) / meta.bins;
      const rad0 = g.disc * (g.r0 + g.k * s0);
      const rad1 = g.disc * (g.r0 + g.k * s1);
      // 0 at 12 o'clock, increasing clockwise
      const a0 = pos * step - Math.PI / 2;
      const a1 = (pos + 1) * step - Math.PI / 2;

      let color: string;
      if (mode === Colour.Amplitude) {
        color = `rgb(${(amp * 255) | 0},${(amp * 242) | 0},${(amp * 217) | 0})`;
      } else if (mode === Colour.Phase) {
        color = hsvToRgb(pixels[o + 1] / 255, 0.75, amp);
      } else {
        const onset = pixels[o + 2] / 255;
        const decay = pixels[o + 3] / 255;
        const l = 0.35 + 0.65 * amp;
        color = onset >= decay
          ? `rgb(${(255 * onset * l) | 0},${(77 * onset * l) | 0},${(51 * onset * l) | 0})`
          : `rgb(${(77 * decay * l) | 0},${(128 * decay * l) | 0},${(255 * decay * l) | 0})`;
      }

      c.strokeStyle = color;
      c.beginPath();
      c.moveTo(cx + Math.cos(a0) * rad0, cy + Math.sin(a0) * rad0);
      c.lineTo(cx + Math.cos(a1) * rad1, cy + Math.sin(a1) * rad1);
      c.stroke();
    }
  }

  private drawOverlay(m: FrameMeta): void {
    const c = this.overlay.getContext("2d");
    if (!c) return;
    const g = this.geometry();
    c.clearRect(0, 0, g.w, g.h);
    if (!this.view.labels) return;

    const cx = g.w / 2;
    const cy = g.h / 2;
    const midiRef = 69 + 12 * Math.log2(m.fRef / 440);
    const dpr = this.glCanvas.width / Math.max(1, this.glCanvas.clientWidth);

    c.font = `${12 * dpr}px ui-monospace, monospace`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.lineWidth = dpr;

    for (let s = 0; s < 12; s++) {
      const a = (s / 12) * Math.PI * 2;
      const ux = Math.sin(a);
      const uy = -Math.cos(a);
      c.beginPath();
      c.moveTo(cx + ux * g.disc * g.r0, cy + uy * g.disc * g.r0);
      c.lineTo(cx + ux * g.disc, cy + uy * g.disc);
      c.stroke();
      const midi = Math.round(midiRef) + s;
      c.fillStyle = "rgba(255,255,255,0.7)";
      c.fillText(NOTES[(((midi % 12) + 12) % 12)], cx + ux * g.disc * 1.03, cy + uy * g.disc * 1.03);
    }

    c.strokeStyle = "rgba(255,255,255,0.06)";
    for (let o = 0; o <= m.octaves; o++) {
      c.beginPath();
      c.arc(cx, cy, g.disc * (g.r0 + g.k * o), 0, Math.PI * 2);
      c.stroke();
    }
  }
}

function hsvToRgb(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const c = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
}
