/*
 * Per-block analysis layer over the receptor bank. Mirrors the sensor pathway of
 * recept.c (period_percept -> period_recept -> period_concept, lifecycle_derive,
 * lifecycle_iter, monochords) but is evaluated once per block of B samples.
 *
 * Every exponential smoother that recept.c applies once per sample with factor f
 * is applied here once per block with alpha_B = 1 - (1 - 1/f)^B, which gives the
 * same time constant (and is exact for a constant input over the block). Deltas
 * that recept.c takes per sample are expressed as per-sample rates (divided by B)
 * so their magnitudes are comparable. With B = 1 the two are identical.
 */
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "bank.h"
#include "tau.h"

static double block_alpha(double factor, double B) {
	if (B <= 1.0) {
		return 1.0 / factor;
	}
	if (!(factor > 1.0)) {  /* also catches NaN; factor = inf gives alpha 0 below */
		return 1.0;
	}
	return -expm1(B * log1p(-1.0 / factor));
}

/* wrap a phase difference in cycles into [-0.5, 0.5) */
static double wrap_tau(double d) {
	return d - floor(d + 0.5);
}

static void lifecycle_init(struct bank_lifecycle *lc, double max_r) {
	memset(lc, 0, sizeof (*lc));
	lc->max_r = max_r;
}

static double lifecycle_sample(struct bank_lifecycle *lc, double complex cval) {
	double prev_phi = lc->phi;

	lc->cval = cval;
	lc->F = creal(cval) - cimag(cval);
	lc->r = cabs(cval);
	lc->phi = rad2tau(carg(cval));
	if (lc->phi - prev_phi > 0.5) {
		lc->cycle--;
	} else if (lc->phi - prev_phi < -0.5) {
		lc->cycle++;
	}
	lc->lifecycle = lc->cycle + lc->phi;
	return lc->lifecycle;
}

int bank_array_init(struct bank_array *a, int scales, int capacity, double response_period,
                    double octave_bandwidth, double scale_factor, double phase_factor, double start_time) {
	memset(a, 0, sizeof (*a));
	if (bank_init(&a->bank, scales, capacity, start_time) == -1) {
		return -1;
	}
	a->scales = scales;
	a->capacity = capacity;
	a->count = 0;
	a->response_period = response_period;
	a->scale_factor = scale_factor;
	a->octave_bandwidth = octave_bandwidth;
	a->period_bandwidth = 1.0 / (pow(2.0, 1.0 / octave_bandwidth) - 1);
	a->phase_factor = phase_factor;
	a->phase = 0.0;
	a->last_time = start_time;
	a->magnitude_mode = BANK_R_EMA;
	bank_set_smoothing(&a->bank, response_period, 8);

	a->sensors = calloc(capacity, sizeof (*a->sensors));
	a->receptors = calloc((size_t) capacity * scales, sizeof (*a->receptors));
	if (a->sensors == NULL || a->receptors == NULL) {
		bank_array_free(a);
		return -1;
	}
	return 0;
}

void bank_array_free(struct bank_array *a) {
	int i;
	if (a->sensors != NULL) {
		for (i = 0; i < a->count; i++) {
			free(a->sensors[i].monochords);
		}
	}
	free(a->sensors);
	free(a->receptors);
	bank_free(&a->bank);
	memset(a, 0, sizeof (*a));
}

int bank_array_add_sensor(struct bank_array *a, double period, double bandwidth_factor) {
	double factors[64];
	struct bank_sensor *sensor;
	int i, s;

	if (a->count == a->capacity || a->scales > 64) {
		return -1;
	}
	i = a->count;
	sensor = &a->sensors[i];
	memset(sensor, 0, sizeof (*sensor));
	sensor->period = period;
	sensor->phase = a->phase;
	sensor->period_factor = a->period_bandwidth * bandwidth_factor;
	sensor->phase_factor = a->phase_factor;
	sensor->response_period = a->response_period;

	for (s = 0; s < a->scales; s++) {
		struct bank_receptor *r = &a->receptors[i * a->scales + s];
		factors[s] = sensor->period_factor * pow(a->scale_factor, -1.0 - s);
		memset(r, 0, sizeof (*r));
		r->avg_instant_period = period;
		r->instant_period_stddev = period;
	}
	if (bank_add_sensor(&a->bank, period, sensor->phase, factors) == -1) {
		return -1;
	}

	lifecycle_init(&sensor->period_lifecycle, period);
	lifecycle_init(&sensor->beat_lifecycle, period);

	return a->count++;
}

int bank_array_populate(struct bank_array *a, double base_period, double octaves, double bandwidth_factor) {
	int n;
	for (n = (int) (-a->octave_bandwidth * octaves); n <= 0; n++) {
		if (bank_array_add_sensor(a, base_period * pow(2, n / a->octave_bandwidth), bandwidth_factor) == -1) {
			return -1;
		}
	}
	return 0;
}

int bank_array_add_monochord(struct bank_array *a, int source, int target, double ratio) {
	struct bank_sensor *t = &a->sensors[target];
	struct bank_monochord *mc;

	if (source < 0 || source >= a->count || target < 0 || target >= a->count) {
		return -1;
	}
	if (t->monochord_count == t->monochord_capacity) {
		int cap = t->monochord_capacity ? t->monochord_capacity * 2 : 4;
		void *p = realloc(t->monochords, cap * sizeof (*t->monochords));
		if (p == NULL) {
			return -1;
		}
		t->monochords = p;
		t->monochord_capacity = cap;
	}
	mc = &t->monochords[t->monochord_count++];
	mc->source = source;
	mc->ratio = ratio;
	mc->period = a->sensors[source].period * ratio;
	mc->offset = t->period - mc->period;
	mc->phi_offset = mc->offset / t->period;
	mc->value = rect1(mc->phi_offset);
	return 0;
}

/* percept: read the receptor state out of the bank */
static void receptor_perceive(struct bank_receptor *r, double complex cval, double r_mean, double time) {
	if (r->has_prior) {
		r->prior_cval = r->cval;
		r->prior_r = r->r;
		r->prior_phi = r->phi;
		r->prior_timestamp = r->timestamp;
	}
	r->cval = cval;
	r->r = cabs(cval);
	r->r_mean = r_mean;
	r->phi = rad2tau(carg(cval));
	r->timestamp = time;
	if (!r->has_prior) {
		r->prior_cval = r->cval;
		r->prior_r = r->r;
		r->prior_phi = r->phi;
		r->prior_timestamp = r->timestamp;
		r->has_prior = 1;
	}
}

/* recept + concept: deduce the instantaneous period and its persistence */
static void receptor_receive(struct bank_receptor *r, const struct bank_sensor *sensor, double B) {
	double phi_t;
	double delta;

	r->frequency = 1.0 / sensor->period;
	if (r->prior_cval != 0.0) {
		/* cval / prior = cval * conj(prior) / |prior|^2; arg of it is wrap(arg(cval) - arg(prior)) */
		double inv = 1.0 / (r->prior_r * r->prior_r);
		r->delta = r->cval * conj(r->prior_cval) * inv;
		r->delta_r = r->r / r->prior_r;
		r->delta_phi = wrap_tau(r->phi - r->prior_phi);
	} else {
		r->delta = 0.0;
		r->delta_r = 0.0;
		r->delta_phi = 0.0;
	}
	r->duration = r->timestamp - r->prior_timestamp;
	phi_t = r->duration > 0 ? r->delta_phi / r->duration : 0.0;
	r->instant_frequency = r->frequency - phi_t;
	r->instant_period = 1.0 / r->instant_frequency;

	r->avg_instant_period += (r->instant_period - r->avg_instant_period) * r->alpha_avg;
	r->avg_instant_period_offset = r->avg_instant_period - sensor->period;

	if (r->has_prior_avg) {
		delta = (r->avg_instant_period - r->prior_avg_instant_period) / B;
	} else {
		delta = r->avg_instant_period;
		r->has_prior_avg = 1;
	}
	r->prior_avg_instant_period = r->avg_instant_period;
	r->instant_period_delta = delta;

	r->instant_period_stddev += (fabs(delta) - r->instant_period_stddev)
	                          * block_alpha(fabs(r->instant_period * sensor->phase_factor), B);
}

static void sensor_lifecycle(struct bank_array *a, int i, double B) {
	struct bank_sensor *sensor = &a->sensors[i];
	struct bank_receptor *rs = &a->receptors[i * a->scales];
	double d1, d2, dd, alpha;
	double lc;

	if (a->scales >= 3) {
		d1 = rs[1].r_mean - rs[0].r_mean;
		d2 = rs[2].r_mean - rs[1].r_mean;
	} else if (a->scales == 2) {
		d1 = rs[1].r_mean - rs[0].r_mean;
		d2 = d1;
	} else {
		d1 = d2 = 0.0;
	}
	dd = d2 - d1;
	sensor->d = d1;
	sensor->dd = dd;
	if (a->magnitude_mode == BANK_R_EMA) {
		/* the magnitudes are already smoothed in the bank; EMA is linear so EMA(r1 - r0) = EMA(r1) - EMA(r0) */
		sensor->d_avg = d1;
		sensor->dd_avg = dd;
	} else {
		alpha = sensor->alpha_response;
		sensor->d_avg  += (d1 - sensor->d_avg)  * alpha;
		sensor->dd_avg += (dd - sensor->dd_avg) * alpha;
	}
	lc = lifecycle_sample(&sensor->period_lifecycle, CMPLX(sensor->d_avg, sensor->dd_avg));

	/* beat lifecycle: first and second per-sample differences of the lifecycle value */
	if (sensor->has_prior_lifecycle) {
		sensor->bd = (lc - sensor->prior_lifecycle) / B;
	}
	sensor->prior_lifecycle = lc;
	sensor->has_prior_lifecycle = 1;
	if (sensor->has_prior_bd) {
		sensor->bdd = (sensor->bd - sensor->prior_bd) / B;
	}
	sensor->prior_bd = sensor->bd;
	sensor->has_prior_bd = 1;
	lifecycle_sample(&sensor->beat_lifecycle, CMPLX(sensor->bd, sensor->bdd));
}

static void bank_array_cache_alphas(struct bank_array *a, double B) {
	int i, s;
	if (a->cached_block == B) {
		return;
	}
	for (i = 0; i < a->count; i++) {
		struct bank_sensor *sensor = &a->sensors[i];
		sensor->alpha_response = block_alpha(sensor->response_period, B);
		{
			double window = 0;
			for (s = 0; s < a->scales; s++) {
				double w = sensor->period * a->bank.period_factor[s * a->bank.capacity + i];
				if (w > window) window = w;
			}
			sensor->alpha_confidence = block_alpha(window, B);
		}
		for (s = 0; s < a->scales; s++) {
			a->receptors[i * a->scales + s].alpha_avg = block_alpha(sensor->period * sensor->phase_factor, B);
		}
	}
	a->cached_block = B;
}

/*
 * Frequency reassignment: where the sensor's receptors say the energy actually is. The position
 * comes from scale 0 (the narrowest receptor, which also feeds the magnitude); the confidence is
 * scale 0's coherence times the agreement of the three scales' frequencies, which a tone keeps and
 * noise or an unresolved pair of tones does not. Agreement is judged against half a receptor
 * bandwidth (600 / octave_bandwidth cents), and the confidence is smoothed over the slowest
 * receptor window so beating does not make it flicker.
 */
static void sensor_reassign(struct bank_array *a, int i) {
	struct bank_sensor *sensor = &a->sensors[i];
	double fc = 1.0 / sensor->period;
	double c0 = 0, spread = 0, agree, raw;
	int s;

	for (s = 0; s < a->scales; s++) {
		double f = fc + bank_if_offset(&a->bank, i, s);
		double c = f > 0 ? 1200.0 * log2(f / fc) : 0.0;
		if (s == 0) {
			c0 = c;
		} else if (fabs(c - c0) > spread) {
			spread = fabs(c - c0);
		}
	}
	agree = 1.0 - spread / (600.0 / a->octave_bandwidth);
	agree = agree < 0 ? 0 : agree > 1 ? 1 : agree;
	raw = bank_if_coherence(&a->bank, i, 0) * agree;
	sensor->if_cents = c0;
	sensor->if_confidence += (raw - sensor->if_confidence) * sensor->alpha_confidence;
}

void bank_array_analyze(struct bank_array *a) {
	double time = a->bank.time;
	double B = time - a->last_time;
	int i, s, m;

	if (B < 1.0) {
		B = 1.0;
	}
	bank_array_cache_alphas(a, B);

	/*
	 * Same result as period_array_sample(), where each sensor senses, superimposes its
	 * monochords (re-receiving), then derives its lifecycle before the next sensor:
	 * sensing is independent per sensor (parallel), monochords are applied in sensor
	 * order (serial, so a source that is itself a target is seen superimposed), and
	 * the lifecycles are again independent (parallel).
	 */
	#pragma omp parallel for schedule(static) private(s)
	for (i = 0; i < a->count; i++) {
		struct bank_sensor *sensor = &a->sensors[i];
		struct bank_receptor *rs = &a->receptors[i * a->scales];
		for (s = 0; s < a->scales; s++) {
			double complex cval = bank_value(&a->bank, i, s);
			double r_mean = a->magnitude_mode != BANK_R_INSTANT ? bank_mean_r(&a->bank, i, s) : cabs(cval);
			receptor_perceive(&rs[s], cval, r_mean, time);
			receptor_receive(&rs[s], sensor, B);
		}
	}
	if (a->magnitude_mode == BANK_R_BLOCK) {
		bank_reset_accumulators(&a->bank);
	}

	for (i = 0; i < a->count; i++) {
		struct bank_sensor *sensor = &a->sensors[i];
		struct bank_receptor *rs = &a->receptors[i * a->scales];
		for (m = 0; m < sensor->monochord_count; m++) {
			struct bank_monochord *mc = &sensor->monochords[m];
			struct bank_receptor *src = &a->receptors[mc->source * a->scales];
			for (s = 0; s < a->scales; s++) {
				double prior_r = rs[s].r;
				rs[s].cval += src[s].cval * mc->value;
				rs[s].r = cabs(rs[s].cval);
				rs[s].phi = rad2tau(carg(rs[s].cval));
				/* block means cannot be superimposed; shift by the instantaneous change (bounded, unlike a ratio) */
				rs[s].r_mean = fmax(0.0, rs[s].r_mean + (rs[s].r - prior_r));
				receptor_receive(&rs[s], sensor, B);
			}
		}
	}

	#pragma omp parallel for schedule(static)
	for (i = 0; i < a->count; i++) {
		sensor_lifecycle(a, i, B);
		sensor_reassign(a, i);
	}

	a->last_time = time;
}

void bank_array_process(struct bank_array *a, const float *x, int n) {
	bank_process(&a->bank, x, n);
	bank_array_analyze(a);
}
