// Heat index from ambient temperature and humidity at the helmet.
// This is heat exposure, not body temperature or heat stress (CLAUDE.md honesty rules).
#pragma once

// NOAA heat index (Rothfusz regression with NWS adjustments), in Celsius.
// Same formula as heat_index_c() in server/simulator.py, so the helmet and the
// simulator agree. Returns NAN if either input is NAN.
float heatIndexC(float temp_c, float humidity_pct);
