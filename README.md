# Receptor Spiral

A bank of **scale-space receptors** — exponential averages standing in for cochlear hair
cells, not an FFT — running on your microphone in WebAssembly and drawn as a pitch spiral.

Audio never leaves the browser: capture, analysis and rendering all happen on the client.

## What it does

Each receptor is one complex exponential average of the demodulated signal:

```
v += α · (x · e^{2πi t / period} − v)
```

That is a one-pole filter centred on the receptor's frequency: a Lorentzian bell whose
width is set entirely by the averaging window. No frames, no windowing, no transform —
every receptor updates on every sample and is readable at any instant. Three of them per
sensor, at different window lengths, give the *scale space*: the second difference of their
magnitudes says whether the response is a peak (a tonal ridge) or broadband, which is what
the default "receptor model" brightness shows. Its complex phase is the sensor's
*lifecycle* — onset, steady, decay.

The spiral puts **angle = pitch class** and **radius = frequency**, one turn per octave. So
octaves line up radially, and a harmonic series is a fixed angular pattern that rotates
with transposition rather than changing shape: the 2nd harmonic sits at the same angle one
turn out, the 3rd at +7 semitones, the 5th at +4.

## Quick start

```sh
bun install
bun dev        # http://localhost:3000  (localhost is a secure context, so the mic works)
```

Production build and tests:

```sh
bun run build  # -> dist/
bun test       # instantiates both .wasm banks and checks the frames they produce
```

## Controls

Two knobs are easy to confuse, because the original C implementation used one number for
both — here they are separate:

| Control | What it sets |
|---|---|
| **bins / octave** | how many receptors are *placed* per octave — display density, and what the CPU cost scales with |
| **selectivity 1/q oct** | how *wide* each receptor's bell is. The window is the beat period against a neighbour 1/q octave away, so `q = 96` is an eighth of a semitone |

Keep `q ≈ bins` for a critically-sampled bank. `q < bins` overlaps the bells (smoother, and
faster to respond); `q > bins` leaves gaps between them, where a tone between two centres
lights neither.

Narrower bells cost time: the window is ~`1/(2^(1/q) − 1)` periods, so at `q = 96` a
receptor takes about 200 ms to rise at 440 Hz and 1.6 s at 55 Hz. That trade is exact for a
one-pole filter — it is the bandwidth–time product, not an implementation limit.

**micro-glissando** sweeps every receptor's centre frequency sinusoidally — the auditory
analogue of the eye's fixational movements. The tonal receptor model responds to change, so a
perfectly steady tone fades from it, the way a stabilised image fades from vision; a slow,
shallow sweep keeps converting the tone's spectral position into temporal change.

Both settings are scale-covariant, so the sweep acts the same at every pitch: **depth** is a
fraction of the bin spacing, and **period** is counted in each sensor's own (slowest)
receptor window, so low notes sweep slowly and high notes quickly. In
`recept/dither_test.c` (55–3520 Hz), the default — 0.35 bin every 12 windows — kept steady
tones visible and separated tones 3 bins apart at every pitch (contrast 0.77–1.0, versus
invisible without the sweep), without adding any tonal response to noise. Periods under
about 6 windows average out; depths over about half a bin smear neighbours together. Expect
the arms to pulse slowly — that is the sweep being seen.

The other controls are display-only: **floor**/**range** set the dB window mapped to black
and to full brightness, **decay** adds visual persistence (0 is honest — the receptors
already integrate), **band** is the arm width, and **resolution** is the render backing
store, which is the main drawing cost.

## Performance

The bank is a structure-of-arrays SIMD loop; the browser build uses WASM SIMD
(`-msimd128`). Measured on an i5-1135G7 laptop core, one thread, 128-sample blocks,
analysis at 60 Hz:

| receptors | float32 | float64 |
|---:|---:|---:|
| 5,400 | 2.9 ms/frame | 4.7 ms/frame |
| 15,000 | 7.7 ms/frame | 13.0 ms/frame |
| 30,000 | 15.6 ms/frame | 26.4 ms/frame |

The budget is 16.7 ms per frame, so **float32 reaches roughly 15–25k receptors in real
time** in one browser thread — about half of what a native AVX-512 thread manages, which is
what 2-lane f64 versus 8-lane hardware SIMD predicts. The status bar reports the actual
figure as a percentage of budget; if it approaches 100%, lower bins/octave or switch to
float32.

float32 costs about 1e-5 relative accuracy — invisible here. Its one weak spot is the
lowest octave at high `q`, where the smoothing factor approaches float32 resolution; switch
to float64 if the innermost turn misbehaves.

## Architecture

```
getUserMedia
   → AudioWorklet (mic-worklet.js)   mixes to mono, forwards 128-sample blocks
   → Worker       (mic-worker.js)    runs bank.wasm, emits one RCP1 frame per 1/60 s
   → main thread  (SpiralEngine)     packs frames into a sensor texture, draws the disc
```

The bank runs in a Worker rather than in the AudioWorklet because that thread has a hard
per-block deadline — overrunning there is an audio glitch, while falling behind in the
worker only costs display frames.

**RCP1** is the frame format: a 48-byte header (magic, sample rate, bins, octaves, sensors,
channels, reference frequency, timestamp) followed by five float32 per sensor — amplitude,
free energy, entropy, energy, lifecycle phase. It is byte-identical to what the native
`bank_stream` produces in the [`recept`](https://github.com/alsosprachben/recept) repo, so
the same viewer can read either source.

Rendering is a single WebGL2 fragment-shader pass: each pixel maps back to (octave, pitch
class) and samples a `bins × octaves` texture, so the GPU handles the resampling as the
turns get denser toward the centre. Where WebGL2 is missing or software-rasterised, a
canvas2d fallback strokes one arc per sensor instead; pick it explicitly under *renderer*.

| Path | What |
|---|---|
| `src/lib/frame.ts` | RCP1 parsing and the brightness/colour packing |
| `src/lib/useMicBank.ts` | microphone → worklet → worker lifecycle |
| `src/render/engine.ts` | the renderer: WebGL2 pass, canvas2d fallback, note overlay |
| `src/render/shaders.ts` | the spiral fragment shader |
| `public/*.wasm` | prebuilt receptor banks (see below) |
| `wasm/` | the C the banks are built from, plus `build.sh` |

## Rebuilding the WebAssembly

`public/bank.wasm` and `public/bank_f32.wasm` are **committed on purpose**: the deploy
builder has Bun but not Emscripten. If you change the C in `wasm/`, rebuild and commit the
binaries alongside it:

```sh
./wasm/build.sh   # needs emcc
bun test          # verifies the new artifacts
```

The C is a copy of the receptor bank from
[`recept`](https://github.com/alsosprachben/recept) (`bank.c`, `bank_array.c`) plus the
browser shim `bank_wasm.c`.

## Deploying

The build is a plain static bundle, so any static host will serve it. It must be served
over HTTPS (or localhost) — `getUserMedia` requires a secure context.

For DataVec's bake (`customer-bake-remote.sh`), the defaults already match — no env
overrides needed:

| Setting | Value |
|---|---|
| `SITE_BUILD_CMD` | `bun run build` (the default) |
| `SITE_DIST_DIR` | `dist` (the default) |
| `SITE_TEST_CMD` | `bun test` (optional, recommended) |

There is no `handlers/` directory, so the bake's transpile step is a no-op and this deploys
as a static-only site.

`bun run build` enforces the deploy caps locally — 5000 files, 10 MiB per file, 50 MiB
total, no symlinks — and fails the build rather than the publish if one is exceeded. The
current output is 7 files, about 243 KiB.

## Licence

MIT — see [LICENSE](LICENSE).
