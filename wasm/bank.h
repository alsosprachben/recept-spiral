#ifndef BANK_H
#define BANK_H

/*
 * Structure-of-arrays receptor bank.
 *
 * Two layers:
 *
 *   1. `struct receptor_bank` (bank.c) is the hot per-sample layer: a bank of
 *      exponentially-smoothed complex receptors ("ear hairs"). Each *sensor*
 *      owns one rotating phasor e^{2 pi i (t + phase) / period}; `scales`
 *      receptors share that phasor and differ only in their smoothing factor.
 *      The state is laid out as flat arrays so the per-sample update vectorizes
 *      across sensors (SIMD) and chunks of sensors can run on separate threads
 *      (OpenMP). It replaces `time_smoothing_d_sample()` in recept.c, which
 *      evaluated cos/sin per receptor per sample.
 *
 *   2. `struct bank_array` (bank_array.c) is the cold per-block layer: the
 *      percept / recept / concept / lifecycle / monochord analysis of recept.c,
 *      evaluated once per block of samples from the bank state rather than
 *      once per sample. Smoothers are rescaled so a block of B samples has
 *      the same time constant as B per-sample updates.
 */

#include <complex.h>
#include <math.h>

#ifndef BANK_REAL
#define BANK_REAL double
#endif
typedef BANK_REAL bank_real;

/* number of sensors processed per cache-resident chunk (also the OpenMP work unit) */
#ifndef BANK_CHUNK
#define BANK_CHUNK 128
#endif

struct receptor_bank {
	int scales;                 /* receptors per sensor */
	int count;                  /* sensors in use */
	int capacity;               /* sensors allocated (row stride of the scale-major arrays) */

	/* per sensor [capacity] */
	bank_real *osc_re, *osc_im; /* phasor for the *next* sample: e^{2 pi i (time + phase) / period} */
	bank_real *rot_re, *rot_im; /* per-sample rotation e^{2 pi i / period} */
	double    *period;
	double    *phase;

	/* per receptor, scale-major [scales * capacity]: index s * capacity + i */
	bank_real *alpha;           /* 1 / (period * period_factor[s]) */
	bank_real *v_re, *v_im;     /* receptor state (the smoothed complex value) */
	bank_real *acc_r;          /* |v| accumulator: plain sum (beta == 0) or EMA with factor beta */
	double    *period_factor;
	long       acc_n;           /* samples accumulated in acc_r (sum mode) */
	bank_real  beta;            /* EMA factor for acc_r (per accumulated sample); 0 selects plain summation */
	int        r_stride;        /* |v| is accumulated every r_stride samples (sqrt is the costly op) */
	int        r_phase;         /* samples until the next accumulation */

	double time;                /* sample index of the next sample */
	long   reseed_interval;     /* samples between exact (cos/sin) phasor reseeds; kills phase drift */
	long   since_reseed;

	/*
	 * Micro-glissando, scale-covariant: sensor i's demodulation frequency is scaled by
	 * 1 + dither_depth * sin(phi_i), where phi_i makes one cycle every dither_windows of that
	 * sensor's own slowest receptor window. Every sensor therefore sees the same sweep relative
	 * to its own time scale, so the effect is the same at every pitch. The sweep is a warp of
	 * each sensor's demodulation clock: its phasor reads time + warp_i instead of time.
	 * The deviation is held per sub-block of BANK_DITHER_BLOCK samples (sub-blocks carry over
	 * between bank_process() calls), and warp_i is integrated exactly, so reseeds agree with
	 * the running phasors. Receptor phases carry the sweep; magnitudes, and so the lifecycle,
	 * need no correction. dither_depth == 0 leaves the per-sample loop unchanged.
	 */
	double     dither_depth;    /* relative frequency deviation, e.g. 2^(cents/1200) - 1 */
	double     dither_windows;  /* sweep period, in each sensor's slowest receptor window */
	int        dither_left;     /* samples left in the current sub-block (0: start a new one) */
	double    *warp;            /* per sensor: clock warp at the start of the current sub-block, samples */
	double    *warp_rate;       /* per sensor: warp gained per sample in the current sub-block */
	double    *dz_re, *dz_im;   /* per sensor: sweep phasor e^{i phi} */
	double    *dr_re, *dr_im;   /* per sensor: sweep phasor rotation per sub-block */
	double    *dw;              /* per sensor: sweep angular rate, radians per sample */
	bank_real *drot_re, *drot_im; /* per sensor: the phasor rotation for the current sub-block */

	/*
	 * Frequency discriminator (for frequency reassignment). At every r_stride point each receptor
	 * forms q = v * conj(v_prev) * conj(c): the phase its value advanced over the stride, with
	 * c = osc * conj(osc_prev) * conj(rot^stride) removing whatever the micro-glissando added to
	 * the demodulator. For a tone at f, arg q = 2 pi stride (f_c - f), unambiguous while
	 * |f - f_c| < 1 / (2 stride) cycles per sample. q is accumulated like acc_r (EMA with beta, or
	 * summed), weighted by |v| |v_prev|; that weight is accumulated too, for the coherence.
	 */
	bank_real *pv_re, *pv_im;   /* per receptor: v at the previous stride point */
	bank_real *pr;              /* per receptor: |v| at the previous stride point */
	bank_real *acc_q_re, *acc_q_im; /* per receptor: accumulated q */
	bank_real *acc_qr;          /* per receptor: accumulated |v| |v_prev| */
	bank_real *posc_re, *posc_im; /* per sensor: phasor at the previous stride point */
	bank_real *rs_re, *rs_im;   /* per sensor: rot^stride, the nominal phasor advance per stride */
	/*
	 * The discriminator's accumulation is scale-covariant: each sensor averages q over a fixed
	 * fraction (q_window_frac) of its slowest receptor window, never shorter than the magnitude
	 * smoothing window.
	 */
	double     q_window_frac;
	double     smoothing_window; /* the magnitude smoothing window, samples (bank_set_smoothing) */
	bank_real *beta_q;          /* per sensor: EMA factor per stride for acc_q / acc_qr */
};

int  bank_init(struct receptor_bank *b, int scales, int capacity, double start_time);
void bank_free(struct receptor_bank *b);
/* period_factors: one per scale. Returns sensor index, or -1 when full. */
int  bank_add_sensor(struct receptor_bank *b, double period, double phase, const double *period_factors);
/* Recompute phasors exactly from `time` (called automatically every reseed_interval samples). */
void bank_reseed(struct receptor_bank *b);
/* Micro-glissando: relative depth of every sensor's centre-frequency sweep (0 disables), and its
   period in units of each sensor's slowest receptor window. Call after or before adding sensors. */
void bank_set_dither(struct receptor_bank *b, double depth, double windows);
/* Advance every receptor by the n samples in x. */
void bank_process(struct receptor_bank *b, const float *x, int n);

/* Zero the |v| accumulators (sum mode; the analysis layer does this after reading them). */
void bank_reset_accumulators(struct receptor_bank *b);
/* Smooth |v| in the bank with an exponential window of `window` samples (0: plain sum per block),
   sampling |v| every `stride` samples. */
void bank_set_smoothing(struct receptor_bank *b, double window, int stride);

static inline double complex bank_value(const struct receptor_bank *b, int sensor, int scale) {
	int k = scale * b->capacity + sensor;
	return (double) b->v_re[k] + I * (double) b->v_im[k];
}

/* Mean magnitude of the receptor: exponentially smoothed (beta > 0) or over the accumulated block. */
static inline double bank_mean_r(const struct receptor_bank *b, int sensor, int scale) {
	int k = scale * b->capacity + sensor;
	if (b->beta > 0) {
		return (double) b->acc_r[k];
	}
	if (b->acc_n > 0) {
		return (double) b->acc_r[k] / (double) b->acc_n;
	}
	return sqrt((double) b->v_re[k] * b->v_re[k] + (double) b->v_im[k] * b->v_im[k]);
}

/* Detected frequency minus the sensor's centre, in cycles per sample (the magnitude-weighted mean
   over the accumulation window); 0 before any accumulation. */
static inline double bank_if_offset(const struct receptor_bank *b, int sensor, int scale) {
	int k = scale * b->capacity + sensor;
	double re = b->acc_q_re[k], im = b->acc_q_im[k];
	if (re == 0 && im == 0) {
		return 0.0;
	}
	return -atan2(im, re) / (6.283185307179586 * b->r_stride);
}

/* How steady that frequency is: |mean q| / mean |q|, in [0, 1]: ~1 for a steady tone, low for noise. */
static inline double bank_if_coherence(const struct receptor_bank *b, int sensor, int scale) {
	int k = scale * b->capacity + sensor;
	double w = b->acc_qr[k];
	return w > 0 ? sqrt((double) b->acc_q_re[k] * b->acc_q_re[k] + (double) b->acc_q_im[k] * b->acc_q_im[k]) / w : 0.0;
}

/* ---- per-block analysis layer ------------------------------------------------ */

struct bank_lifecycle {
	double max_r;
	double F;         /* free energy: creal(cval) - cimag(cval) */
	double r;
	double phi;
	int    cycle;
	double lifecycle;
	double complex cval;
};

struct bank_receptor {
	/* percept */
	double timestamp;
	double complex cval;
	double r, phi;                     /* instantaneous, at the block end */
	double r_mean;                     /* RMS magnitude over the block (drives the lifecycle) */
	int    has_prior;
	double prior_timestamp;
	double complex prior_cval;
	double prior_r, prior_phi;
	/* recept */
	double duration;
	double complex delta;
	double delta_r, delta_phi;
	double frequency;
	double instant_frequency;
	double instant_period;
	/* concept */
	double avg_instant_period;
	double avg_instant_period_offset;
	double instant_period_delta;       /* per-sample rate */
	double instant_period_stddev;
	int    has_prior_avg;
	double prior_avg_instant_period;
	double alpha_avg;                  /* block alpha of period * phase_factor, cached per block size */
};

struct bank_monochord {
	int    source;                     /* source sensor index */
	double ratio;
	double period, offset, phi_offset;
	double complex value;              /* rotation applied to the source value */
};

struct bank_sensor {
	double period;
	double phase;
	double period_factor;              /* base factor; scale s uses period_factor * scale_factor^(-1-s) */
	double phase_factor;
	double response_period;
	double alpha_response;             /* block alpha of response_period, cached per block size */

	/* frequency reassignment (from the bank's discriminator) */
	double if_cents;                   /* detected frequency minus the centre, cents (scale 0) */
	double if_confidence;              /* coherence x agreement across scales, smoothed; 0..1 */
	double alpha_confidence;           /* block alpha of the slowest receptor window */

	/* period lifecycle (derived from the receptor magnitudes across scales) */
	double d, dd, d_avg, dd_avg;
	struct bank_lifecycle period_lifecycle;

	/* beat lifecycle (iterated deltas of the period lifecycle, as per-sample rates) */
	double bd, bdd;
	int    has_prior_lifecycle, has_prior_bd;
	double prior_lifecycle, prior_bd;
	struct bank_lifecycle beat_lifecycle;

	struct bank_monochord *monochords;
	int monochord_count, monochord_capacity;
};

struct bank_array {
	struct receptor_bank bank;
	int scales;
	int count, capacity;

	double response_period;
	double scale_factor;
	double octave_bandwidth;
	double period_bandwidth;
	double phase_factor;
	double phase;

	struct bank_sensor   *sensors;     /* [capacity] */
	struct bank_receptor *receptors;   /* [capacity * scales], index sensor * scales + scale */

	double last_time;                  /* time of the previous analysis */
	double cached_block;               /* block size the cached alphas were computed for */
	/* how the lifecycle sees receptor magnitudes:
	 *   BANK_R_INSTANT  block-end magnitude, smoothed per block (same structure as recept.c)
	 *   BANK_R_BLOCK    block RMS magnitude, smoothed per block
	 *   BANK_R_EMA      (default) |v| smoothed per sample inside the bank with 1/response_period;
	 *                   the lifecycle takes differences of the smoothed magnitudes directly */
	int    magnitude_mode;
};
enum { BANK_R_INSTANT = 0, BANK_R_BLOCK = 1, BANK_R_EMA = 2 };

int  bank_array_init(struct bank_array *a, int scales, int capacity, double response_period,
                     double octave_bandwidth, double scale_factor, double phase_factor, double start_time);
void bank_array_free(struct bank_array *a);
int  bank_array_add_sensor(struct bank_array *a, double period, double bandwidth_factor);
/* base_period * 2^(n / octave_bandwidth) for n in [-octave_bandwidth * octaves, 0] */
int  bank_array_populate(struct bank_array *a, double base_period, double octaves, double bandwidth_factor);
int  bank_array_add_monochord(struct bank_array *a, int source, int target, double ratio);
/* Run the bank over n samples, then the analysis once for the block. */
void bank_array_process(struct bank_array *a, const float *x, int n);
/* Analysis only (the bank must have been advanced already). */
void bank_array_analyze(struct bank_array *a);

static inline struct bank_receptor *bank_array_receptor(struct bank_array *a, int sensor, int scale) {
	return &a->receptors[sensor * a->scales + scale];
}

#endif
