#include <stdlib.h>
#include <string.h>
#include <math.h>
#ifdef BANK_REAL_IS_FLOAT
#define sqrt sqrtf
#endif

#include "bank.h"
#include "tau.h"

#if defined(__SSE__) || defined(__x86_64__)
#include <xmmintrin.h>
#include <pmmintrin.h>
/*
 * Receptor states decay toward zero on silence and become denormal floats, which the
 * CPU handles ~100x slower (a quiet microphone made the bank fall behind real time).
 * The values involved are far below anything audible, so flush them to zero. MXCSR is
 * per thread, hence this runs in the worker rather than once at startup.
 */
static inline void bank_flush_denormals(void) {
	_MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);
	_MM_SET_DENORMALS_ZERO_MODE(_MM_DENORMALS_ZERO_ON);
}
#else
static inline void bank_flush_denormals(void) {}
#endif

static void *bank_alloc(size_t n, size_t size) {
	size_t bytes = n * size;
	void *p;
	/* aligned_alloc requires the size to be a multiple of the alignment */
	bytes = (bytes + 63) & ~(size_t) 63;
	p = aligned_alloc(64, bytes);
	if (p != NULL) {
		memset(p, 0, bytes);
	}
	return p;
}

int bank_init(struct receptor_bank *b, int scales, int capacity, double start_time) {
	size_t n = (size_t) capacity;
	size_t sn = (size_t) scales * capacity;

	memset(b, 0, sizeof (*b));
	b->scales = scales;
	b->capacity = capacity;
	b->count = 0;
	b->time = start_time;
	b->reseed_interval = 65536;
	b->since_reseed = 0;

	b->osc_re = bank_alloc(n, sizeof (bank_real));
	b->osc_im = bank_alloc(n, sizeof (bank_real));
	b->rot_re = bank_alloc(n, sizeof (bank_real));
	b->rot_im = bank_alloc(n, sizeof (bank_real));
	b->period = bank_alloc(n, sizeof (double));
	b->phase  = bank_alloc(n, sizeof (double));
	b->alpha  = bank_alloc(sn, sizeof (bank_real));
	b->v_re   = bank_alloc(sn, sizeof (bank_real));
	b->v_im   = bank_alloc(sn, sizeof (bank_real));
	b->acc_r = bank_alloc(sn, sizeof (bank_real));
	b->period_factor = bank_alloc(sn, sizeof (double));
	b->drot_re = bank_alloc(n, sizeof (bank_real));
	b->drot_im = bank_alloc(n, sizeof (bank_real));
	b->acc_n = 0;
	b->beta = 0;
	b->r_stride = 1;
	b->r_phase = 0;

	if (b->osc_re == NULL || b->osc_im == NULL || b->rot_re == NULL || b->rot_im == NULL ||
	    b->period == NULL || b->phase == NULL || b->alpha == NULL || b->v_re == NULL ||
	    b->v_im == NULL || b->acc_r == NULL || b->period_factor == NULL ||
	    b->drot_re == NULL || b->drot_im == NULL) {
		bank_free(b);
		return -1;
	}

	/* unused rows must be harmless: rot = 1, alpha = 0 */
	for (size_t i = 0; i < n; i++) {
		b->rot_re[i] = 1;
		b->drot_re[i] = 1;
		b->osc_re[i] = 1;
	}
	return 0;
}

void bank_free(struct receptor_bank *b) {
	free(b->osc_re); free(b->osc_im);
	free(b->rot_re); free(b->rot_im);
	free(b->period); free(b->phase);
	free(b->alpha);  free(b->v_re); free(b->v_im); free(b->acc_r);
	free(b->period_factor);
	free(b->drot_re); free(b->drot_im);
	memset(b, 0, sizeof (*b));
}

static void bank_seed_sensor(struct receptor_bank *b, int i) {
	double tau = (b->time + b->warp + b->phase[i]) / b->period[i];
	double rad = tau2rad(tau);
	b->osc_re[i] = (bank_real) cos(rad);
	b->osc_im[i] = (bank_real) sin(rad);
}

int bank_add_sensor(struct receptor_bank *b, double period, double phase, const double *period_factors) {
	int i;
	int s;
	double rad;

	if (b->count == b->capacity) {
		return -1;
	}
	i = b->count++;

	b->period[i] = period;
	b->phase[i]  = phase;
	rad = tau2rad(1.0 / period);
	b->rot_re[i] = (bank_real) cos(rad);
	b->rot_im[i] = (bank_real) sin(rad);
	bank_seed_sensor(b, i);

	for (s = 0; s < b->scales; s++) {
		int k = s * b->capacity + i;
		b->period_factor[k] = period_factors[s];
		b->alpha[k] = (bank_real) (1.0 / (period * period_factors[s]));
		b->v_re[k] = 0;
		b->v_im[k] = 0;
	}
	return i;
}

void bank_reset_accumulators(struct receptor_bank *b) {
	memset(b->acc_r, 0, (size_t) b->scales * b->capacity * sizeof (bank_real));
	b->acc_n = 0;
}

void bank_set_smoothing(struct receptor_bank *b, double window, int stride) {
	if (stride < 1) {
		stride = 1;
	}
	/* an EMA stepped every `stride` samples with the same time constant as a per-sample window */
	b->beta = window > 0 ? (bank_real) (1.0 - pow(1.0 - 1.0 / window, stride)) : 0;
	b->r_stride = stride;
	b->r_phase = 0;
	bank_reset_accumulators(b);
}

void bank_reseed(struct receptor_bank *b) {
	int i;
	for (i = 0; i < b->count; i++) {
		bank_seed_sensor(b, i);
	}
	b->since_reseed = 0;
}

/*
 * Time-blocked update: for each cache-resident chunk of sensors, run all n samples.
 * Within a sample, the phasor rotation and the per-scale smoother updates are
 * separate SIMD loops over the chunk, communicating through small stack arrays.
 */
static void bank_process_chunk(struct receptor_bank *b, int c0, int c1, const float *x, int n,
                               const bank_real * restrict rot_re, const bank_real * restrict rot_im) {
	bank_real * restrict osc_re = b->osc_re;
	bank_real * restrict osc_im = b->osc_im;
	const bank_real * restrict alpha = b->alpha;
	bank_real * restrict v_re = b->v_re;
	bank_real * restrict v_im = b->v_im;
	bank_real * restrict acc_r = b->acc_r;
	const bank_real beta = b->beta;
	const int stride = b->r_stride;
	int phase = b->r_phase;
	const int cap = b->capacity;
	const int S = b->scales;
	bank_real xr[BANK_CHUNK], xi[BANK_CHUNK];
	int k, s, i;

	bank_flush_denormals();

	for (k = 0; k < n; k++) {
		const bank_real xs = (bank_real) x[k];

		/* mix the sample with each sensor's phasor, then advance the phasor */
		#pragma omp simd
		for (i = c0; i < c1; i++) {
			bank_real o_re = osc_re[i], o_im = osc_im[i];
			xr[i - c0] = xs * o_re;
			xi[i - c0] = xs * o_im;
			osc_re[i] = o_re * rot_re[i] - o_im * rot_im[i];
			osc_im[i] = o_re * rot_im[i] + o_im * rot_re[i];
		}

		/* v += alpha * (x * osc - v) for every scale */
		for (s = 0; s < S; s++) {
			bank_real * restrict vr = v_re + (size_t) s * cap;
			bank_real * restrict vi = v_im + (size_t) s * cap;
			const bank_real * restrict al = alpha + (size_t) s * cap;
			#pragma omp simd
			for (i = c0; i < c1; i++) {
				vr[i] += al[i] * (xr[i - c0] - vr[i]);
				vi[i] += al[i] * (xi[i - c0] - vi[i]);
			}
		}

		/* every r_stride samples: accumulate |v| (sum, or EMA when beta > 0) */
		if (phase == 0) {
			for (s = 0; s < S; s++) {
				const bank_real * restrict vr = v_re + (size_t) s * cap;
				const bank_real * restrict vi = v_im + (size_t) s * cap;
				bank_real * restrict acc = acc_r + (size_t) s * cap;
				if (beta > 0) {
					#pragma omp simd
					for (i = c0; i < c1; i++) {
						acc[i] += beta * (sqrt(vr[i] * vr[i] + vi[i] * vi[i]) - acc[i]);
					}
				} else {
					#pragma omp simd
					for (i = c0; i < c1; i++) {
						acc[i] += sqrt(vr[i] * vr[i] + vi[i] * vi[i]);
					}
				}
			}
			phase = stride;
		}
		phase--;
	}

	/* pull the phasor magnitudes back to 1 (first-order Newton step) */
	#pragma omp simd
	for (i = c0; i < c1; i++) {
		bank_real m = osc_re[i] * osc_re[i] + osc_im[i] * osc_im[i];
		bank_real g = (bank_real) 1.5 - (bank_real) 0.5 * m;
		osc_re[i] *= g;
		osc_im[i] *= g;
	}
}

void bank_set_dither(struct receptor_bank *b, double depth, double rate) {
	/* warp is kept when the dither stops, so the phasors stay continuous with the next reseed */
	b->dither_depth = depth;
	b->dither_rate = rate;
}

/*
 * Set drot to each sensor's rotation for the next m samples of dither, and advance the warp.
 * The frequency deviation depth * sin(phase) is held at its mean over the sub-block, so the
 * warp gained over the sub-block is exact and the phasors agree with bank_seed_sensor().
 */
static void bank_dither_rotation(struct receptor_bank *b, int m) {
	const double w = tau2rad(b->dither_rate);
	const double p0 = b->dither_phase;
	double dwarp, delta;
	int i;

	if (w != 0.0) {
		dwarp = b->dither_depth * (cos(p0) - cos(p0 + w * m)) / w;
	} else {
		dwarp = b->dither_depth * sin(p0) * m;
	}
	delta = dwarp / m;
	b->warp += dwarp;
	b->dither_phase = fmod(p0 + w * m, tau2rad(1.0));

	/* rot * e^{i a}, a = 2 pi delta / period: a is small (|delta| < ~3%), so a 3rd-order series is plenty */
	for (i = 0; i < b->count; i++) {
		double a = tau2rad(delta / b->period[i]);
		double c = 1.0 - 0.5 * a * a;
		double s = a - a * a * a / 6.0;
		double r_re = b->rot_re[i], r_im = b->rot_im[i];
		b->drot_re[i] = (bank_real) (r_re * c - r_im * s);
		b->drot_im[i] = (bank_real) (r_re * s + r_im * c);
	}
}

static void bank_process_block(struct receptor_bank *b, const float *x, int n,
                               const bank_real *rot_re, const bank_real *rot_im) {
	const int M = b->count;
	int c0;

	#pragma omp parallel for schedule(static)
	for (c0 = 0; c0 < M; c0 += BANK_CHUNK) {
		int c1 = c0 + BANK_CHUNK < M ? c0 + BANK_CHUNK : M;
		bank_process_chunk(b, c0, c1, x, n, rot_re, rot_im);
	}

	b->time += n;
	/* accumulations happen at samples k >= r_phase with (k - r_phase) % r_stride == 0 */
	if (n > b->r_phase) {
		b->acc_n += (n - 1 - b->r_phase) / b->r_stride + 1;
	}
	b->r_phase = ((b->r_phase - n) % b->r_stride + b->r_stride) % b->r_stride;
	b->since_reseed += n;
	if (b->since_reseed >= b->reseed_interval) {
		bank_reseed(b);
	}
}

/* samples per dither sub-block: the frequency deviation is stepped at sr / 64 (~700 Hz) */
#ifndef BANK_DITHER_BLOCK
#define BANK_DITHER_BLOCK 64
#endif

void bank_process(struct receptor_bank *b, const float *x, int n) {
	if (n <= 0) {
		return;
	}
	if (b->dither_depth == 0.0) {
		bank_process_block(b, x, n, b->rot_re, b->rot_im);
		return;
	}
	while (n > 0) {
		int m = n < BANK_DITHER_BLOCK ? n : BANK_DITHER_BLOCK;
		bank_dither_rotation(b, m);
		bank_process_block(b, x, m, b->drot_re, b->drot_im);
		x += m;
		n -= m;
	}
}
