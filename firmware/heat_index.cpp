#include "heat_index.h"

#include <math.h>

float heatIndexC(float temp_c, float humidity_pct) {
  if (isnan(temp_c) || isnan(humidity_pct)) return NAN;
  const double t = temp_c * 9.0 / 5.0 + 32.0;
  const double rh = humidity_pct;
  double hi = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094);
  if ((hi + t) / 2.0 >= 80.0) {
    hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
         - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
         + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    if (rh < 13.0 && t >= 80.0 && t <= 112.0) {
      hi -= ((13.0 - rh) / 4.0) * sqrt((17.0 - fabs(t - 95.0)) / 17.0);
    } else if (rh > 85.0 && t >= 80.0 && t <= 87.0) {
      hi += ((rh - 85.0) / 10.0) * ((87.0 - t) / 5.0);
    }
  }
  return (float)((hi - 32.0) * 5.0 / 9.0);
}
