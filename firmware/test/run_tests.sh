#!/usr/bin/env bash
# Builds and runs the firmware logic tests on a laptop (Linux, macOS, or WSL; needs g++).
# On Windows: wsl bash firmware/test/run_tests.sh
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)/firmware_tests"
g++ -std=c++17 -Wall -Wextra -Werror -O1 -o "$out" \
  test_logic.cpp ../fall_detector.cpp ../heat_index.cpp ../payload.cpp ../event_queue.cpp -lm
"$out"
