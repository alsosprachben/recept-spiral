/*
 * WebAssembly shim around the receptor bank: one global bank_array, a float input
 * buffer, and an output buffer holding an RCP1 frame (same layout as bank_stream.c)
 * so the browser can feed it audio blocks and draw the result with spiral.html.
 *
 *   emcc -O3 -msimd128 -fopenmp-simd -sSTANDALONE_WASM --no-entry ... -o bank.wasm
 *
 * Exports:
 *   bank_wasm_init(sr, bins, octaves, f_ref, octave_div, frame_rate, stride, bandwidth_factor) -> sensors
 *   bank_wasm_input(max_samples)   -> float* (input buffer, at least max_samples long)
 *   bank_wasm_process(n)           -> 1 if a frame was produced (every block of sr/frame_rate samples)
 *   bank_wasm_frame()              -> unsigned char* (RCP1 frame)
 *   bank_wasm_frame_size()         -> bytes
 *   bank_wasm_set_dither(cents, windows) micro-glissando: every sensor's centre sweeps +-cents, one cycle
 *                                  per `windows` of its own slowest receptor window (0 cents disables); kept across init
 *   bank_wasm_free()
 */
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

#include "bank.h"

#define CHANNELS 5

struct frame_header {
	char     magic[4];
	uint32_t header_size;
	double   time;
	uint32_t sample_rate;
	uint32_t bins_per_octave;
	uint32_t octaves;
	uint32_t sensors;
	uint32_t channels;
	float    f_ref;
	uint32_t stamp_ms;
};

static struct bank_array g_bank;
static int g_ready = 0;
static int g_sensors = 0;
static int g_block = 0;
static int g_filled = 0;
static float *g_input = NULL;
static int g_input_cap = 0;
static float *g_block_buf = NULL;
static unsigned char *g_frame = NULL;
static size_t g_frame_size = 0;
static struct frame_header g_hdr;
static double g_dither_cents = 0.0;
static double g_dither_windows = 0.0;

#define EXPORT __attribute__((used, visibility("default")))

EXPORT void bank_wasm_free(void) {
	if (g_ready) {
		bank_array_free(&g_bank);
		g_ready = 0;
	}
	free(g_input); g_input = NULL; g_input_cap = 0;
	free(g_block_buf); g_block_buf = NULL;
	free(g_frame); g_frame = NULL; g_frame_size = 0;
}

static void apply_dither(void) {
	if (g_ready) {
		bank_set_dither(&g_bank.bank, pow(2, g_dither_cents / 1200.0) - 1.0, g_dither_windows);
	}
}

EXPORT void bank_wasm_set_dither(double cents, double windows) {
	g_dither_cents = cents;
	g_dither_windows = windows;
	apply_dither();
}

EXPORT int bank_wasm_init(double sr, int bins, int octaves, double f_ref, double octave_div,
                          double frame_rate, int stride, double bandwidth_factor) {
	const double cycle_area = 1.0 / (1.0 - exp(-1.0));
	int i;

	bank_wasm_free();
	g_sensors = bins * octaves;
	g_block = (int) (sr / frame_rate + 0.5);
	g_filled = 0;

	if (bank_array_init(&g_bank, 3, g_sensors, sr / frame_rate, octave_div, cycle_area, cycle_area, 0.0) == -1) {
		return -1;
	}
	g_ready = 1;
	bank_set_smoothing(&g_bank.bank, sr / frame_rate, stride > 0 ? stride : 8);
	for (i = 0; i < g_sensors; i++) {
		double period = sr / (f_ref * pow(2, (double) i / bins));
		if (period < 2.0) period = 2.0;
		if (bank_array_add_sensor(&g_bank, period, bandwidth_factor) == -1) {
			return -1;
		}
	}

	g_block_buf = malloc(g_block * sizeof (float));
	g_frame_size = sizeof (g_hdr) + (size_t) g_sensors * CHANNELS * sizeof (float);
	g_frame = malloc(g_frame_size);
	if (g_block_buf == NULL || g_frame == NULL) {
		return -1;
	}

	memset(&g_hdr, 0, sizeof (g_hdr));
	memcpy(g_hdr.magic, "RCP1", 4);
	g_hdr.header_size = sizeof (g_hdr);
	g_hdr.sample_rate = (uint32_t) sr;
	g_hdr.bins_per_octave = bins;
	g_hdr.octaves = octaves;
	g_hdr.sensors = g_sensors;
	g_hdr.channels = CHANNELS;
	g_hdr.f_ref = (float) f_ref;
	apply_dither();
	return g_sensors;
}

EXPORT float *bank_wasm_input(int max_samples) {
	if (max_samples > g_input_cap) {
		float *p = realloc(g_input, max_samples * sizeof (float));
		if (p == NULL) return NULL;
		g_input = p;
		g_input_cap = max_samples;
	}
	return g_input;
}

EXPORT unsigned char *bank_wasm_frame(void) { return g_frame; }
EXPORT int bank_wasm_frame_size(void) { return (int) g_frame_size; }
EXPORT int bank_wasm_block(void) { return g_block; }

/* Feed n samples (already scaled like bank_stream: +-1 audio times 10000). A frame is produced
   each time a full block has accumulated; returns the number of frames produced (0 or 1 for n <= block). */
EXPORT int bank_wasm_process(int n, uint32_t stamp_ms) {
	int produced = 0;
	int off = 0;
	if (!g_ready || g_input == NULL) return 0;
	while (off < n) {
		int take = g_block - g_filled;
		if (take > n - off) take = n - off;
		memcpy(g_block_buf + g_filled, g_input + off, take * sizeof (float));
		g_filled += take;
		off += take;
		if (g_filled == g_block) {
			float *d = (float *) (g_frame + sizeof (g_hdr));
			int i;
			bank_array_process(&g_bank, g_block_buf, g_block);
			g_filled = 0;
			for (i = 0; i < g_sensors; i++) {
				const struct bank_sensor *s = &g_bank.sensors[i];
				float *row = d + (size_t) i * CHANNELS;
				row[0] = (float) bank_array_receptor(&g_bank, i, 0)->r_mean;
				row[1] = (float) s->period_lifecycle.F;
				row[2] = (float) creal(s->period_lifecycle.cval);
				row[3] = (float) cimag(s->period_lifecycle.cval);
				row[4] = (float) s->period_lifecycle.phi;
			}
			g_hdr.time = g_bank.bank.time;
			g_hdr.stamp_ms = stamp_ms;
			memcpy(g_frame, &g_hdr, sizeof (g_hdr));
			produced++;
		}
	}
	return produced;
}
