#ifndef TAU_H
#define TAU_H

#include <math.h>
#include <complex.h>

#ifndef CMPLX
#define CMPLX(x, y) ((double complex)((double)(x) + _Complex_I * (double)(y)))
#endif
#ifndef CMPLXF
#define CMPLXF(x, y) ((float complex)((float)(x) + _Complex_I * (float)(y)))
#endif
#ifndef CMPLXL
#define CMPLXL(x, y) ((long double complex)((long double)(x) + _Complex_I * (long double)(y)))
#endif

#define RADIAN_CYCLE (M_PI * 2)

#define rad2tau(rad) (fmod(((rad) / RADIAN_CYCLE) + 0.5, 1) - 0.5)
#define tau2rad(tau)       ((tau) * RADIAN_CYCLE)

#define rad_rect1(rad)      CMPLX(cos(rad),         sin(rad))
#define rad_rect( rad, mag) CMPLX(cos(rad) * (mag), sin(rad) * (mag))
#define rect1(    tau)      rad_rect1(      tau2rad(tau))
#define rect(     tau, mag) rad_rect((mag), tau2rad(tau))

#define rad_polar(cval) (cabs(cval),         carg(cval))
#define polar(    cval) (cabs(cval), rad2tau(carg(cval)))

#endif
