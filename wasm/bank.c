#include <stdlib.h>
#include <string.h>
#include <math.h>
#ifdef BANK_REAL_IS_FLOAT
#define sqrt sqrtf
#endif

#include "bank.h"
#include "tau.h"

/* samples per dither sub-block: each sensor's frequency deviation is stepped at sr / 64 (~700 Hz) */
#ifndef BANK_DITHER_BLOCK
#define BANK_DITHER_BLOCK 64
#endif

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
	b->warp      = bank_alloc(n, sizeof (double));
	b->warp_rate = bank_alloc(n, sizeof (double));
	b->dz_re = bank_alloc(n, sizeof (double));
	b->dz_im = bank_alloc(n, sizeof (double));
	b->dr_re = bank_alloc(n, sizeof (double));
	b->dr_im = bank_alloc(n, sizeof (double));
	b->dw    = bank_alloc(n, sizeof (double));
	b->acc_n = 0;
	b->beta = 0;
	b->r_stride = 1;
	b->r_phase = 0;

	if (b->osc_re == NULL || b->osc_im == NULL || b->rot_re == NULL || b->rot_im == NULL ||
	    b->period == NULL || b->phase == NULL || b->alpha == NULL || b->v_re == NULL ||
	    b->v_im == NULL || b->acc_r == NULL || b->period_factor == NULL ||
	    b->drot_re == NULL || b->drot_im == NULL || b->warp == NULL || b->warp_rate == NULL ||
	    b->dz_re == NULL || b->dz_im == NULL || b->dr_re == NULL || b->dr_im == NULL || b->dw == NULL) {
		bank_free(b);
		return -1;
	}

	/* unused rows must be harmless: rot = 1, alpha = 0 */
	for (size_t i = 0; i < n; i++) {
		b->rot_re[i] = 1;
		b->drot_re[i] = 1;
		b->dz_re[i] = 1;
		b->dr_re[i] = 1;
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
	free(b->warp); free(b->warp_rate);
	free(b->dz_re); free(b->dz_im); free(b->dr_re); free(b->dr_im); free(b->dw);
	memset(b, 0, sizeof (*b));
}

static void bank_seed_sensor(struct receptor_bank *b, int i) {
	/* the clock warp reached so far in the current dither sub-block */
	double elapsed = b->dither_left > 0 ? BANK_DITHER_BLOCK - b->dither_left : 0;
	double tau = (b->time + b->warp[i] + b->warp_rate[i] * elapsed + b->phase[i]) / b->period[i];
	double rad = tau2rad(tau);
	b->osc_re[i] = (bank_real) cos(rad);
	b->osc_im[i] = (bank_real) sin(rad);
}

/* sensor i's sweep rate: one cycle per dither_windows of its slowest (largest) receptor window */
static void bank_dither_sensor(struct receptor_bank *b, int i) {
	double window = 0;
	int s;
	for (s = 0; s < b->scales; s++) {
		double w = b->period[i] * b->period_factor[s * b->capacity + i];
		if (w > window) window = w;
	}
	b->dw[i] = b->dither_windows > 0 && window > 0 ? tau2rad(1.0 / (b->dither_windows * window)) : 0;
	b->dr_re[i] = cos(b->dw[i] * BANK_DITHER_BLOCK);
	b->dr_im[i] = sin(b->dw[i] * BANK_DITHER_BLOCK);
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
	b->warp[i] = 0;
	b->warp_rate[i] = 0;
	b->dz_re[i] = 1;
	b->dz_im[i] = 0;
	bank_dither_sensor(b, i);
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

/* fold the part of the current sub-block already run into warp, so the sweep can change or stop */
static void bank_dither_settle(struct receptor_bank *b) {
	int i;
	double elapsed = b->dither_left > 0 ? BANK_DITHER_BLOCK - b->dither_left : 0;
	for (i = 0; i < b->count; i++) {
		b->warp[i] += b->warp_rate[i] * elapsed;
		b->warp_rate[i] = 0;
	}
	b->dither_left = 0;
}

void bank_set_dither(struct receptor_bank *b, double depth, double windows) {
	int i;
	/* warp is kept when the sweep stops, so the phasors stay continuous with the next reseed */
	bank_dither_settle(b);
	b->dither_depth = depth;
	b->dither_windows = windows;
	for (i = 0; i < b->count; i++) {
		bank_dither_sensor(b, i);
	}
}

/*
 * Start a dither sub-block: advance each sensor's sweep phasor by one sub-block, set its warp
 * rate to the exact mean of depth * sin(phi) over the sub-block, and set drot to the phasor
 * rotation that includes it. The previous sub-block's warp is folded in first.
 */
static void bank_dither_rotation(struct receptor_bank *b) {
	const double depth = b->dither_depth;
	int i;

	for (i = 0; i < b->count; i++) {
		double z_re = b->dz_re[i], z_im = b->dz_im[i];
		double n_re = z_re * b->dr_re[i] - z_im * b->dr_im[i];
		double n_im = z_re * b->dr_im[i] + z_im * b->dr_re[i];
		double g = 1.5 - 0.5 * (n_re * n_re + n_im * n_im);
		double rate, a, c, sn, r_re, r_im;

		n_re *= g;
		n_im *= g;
		b->warp[i] += b->warp_rate[i] * BANK_DITHER_BLOCK;
		/* mean of depth * sin(phi) over the sub-block: depth * (cos phi0 - cos phi1) / (w * B) */
		rate = b->dw[i] > 0 ? depth * (z_re - n_re) / (b->dw[i] * BANK_DITHER_BLOCK) : 0;
		b->warp_rate[i] = rate;
		b->dz_re[i] = n_re;
		b->dz_im[i] = n_im;

		/* rot * e^{i a}, a = 2 pi rate / period: a is small (|rate| < ~3%), so a 3rd-order series is plenty */
		a = tau2rad(rate / b->period[i]);
		c = 1.0 - 0.5 * a * a;
		sn = a - a * a * a / 6.0;
		r_re = b->rot_re[i];
		r_im = b->rot_im[i];
		b->drot_re[i] = (bank_real) (r_re * c - r_im * sn);
		b->drot_im[i] = (bank_real) (r_re * sn + r_im * c);
	}
	b->dither_left = BANK_DITHER_BLOCK;
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
}

void bank_process(struct receptor_bank *b, const float *x, int n) {
	if (n <= 0) {
		return;
	}
	if (b->dither_depth == 0.0) {
		bank_process_block(b, x, n, b->rot_re, b->rot_im);
	} else {
		while (n > 0) {
			int m;
			if (b->dither_left == 0) {
				bank_dither_rotation(b);
			}
			m = n < b->dither_left ? n : b->dither_left;
			bank_process_block(b, x, m, b->drot_re, b->drot_im);
			b->dither_left -= m;
			x += m;
			n -= m;
		}
	}
	/* reseed only once dither_left is current, so the seeds include the warp run so far */
	if (b->since_reseed >= b->reseed_interval) {
		bank_reseed(b);
	}
}
