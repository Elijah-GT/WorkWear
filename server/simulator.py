#!/usr/bin/env python3
"""Fake helmets, for building and demoing the dashboard without hardware.

Sends telemetry for N simulated helmets once a second and, optionally, a fall
every few seconds, following docs/PROTOCOL.md. Device IDs start with "sim-",
so the server marks their incidents as sample data.

Standard library only. Examples:
    python simulator.py --devices 3 --fall-every 30
    python simulator.py --url http://192.168.43.10:8000 --heat-ramp 2 --resend
"""

import argparse
import json
import math
import random
import sys
import time
import urllib.error
import urllib.request

RETRY_EVERY_S = 2         # PROTOCOL.md 2.2: failed falls are retried every 2 s
STILL_AFTER_FALL_S = 5    # after a fall the helmet lies still and tilted for a while
MAX_TEMP_C = 50.0         # --heat-ramp stops here


def heat_index_c(temp_c: float, humidity_pct: float) -> float:
    """NOAA heat index (Rothfusz regression with NWS adjustments), in Celsius.

    The firmware should use the same formula, so the two can be checked against each other.
    """
    t = temp_c * 9 / 5 + 32
    rh = humidity_pct
    hi = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094)
    if (hi + t) / 2 >= 80:
        hi = (-42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
              - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
              + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh)
        if rh < 13 and 80 <= t <= 112:
            hi -= ((13 - rh) / 4) * math.sqrt((17 - abs(t - 95)) / 17)
        elif rh > 85 and 80 <= t <= 87:
            hi += ((rh - 85) / 10) * ((87 - t) / 5)
    return (hi - 32) * 5 / 9


class Helmet:
    def __init__(self, device_id: str, rng: random.Random):
        self.device_id = device_id
        self.uptime_offset_ms = rng.randint(10_000, 600_000)  # helmets were switched on at different times
        self.base_temp_c = rng.uniform(22.0, 29.0)
        self.humidity_pct = rng.uniform(35.0, 60.0)
        self.pressure_hpa = rng.uniform(1005.0, 1015.0)
        self.fallen_at = None  # sim time of the last fall

    def uptime_ms(self, t: float) -> int:
        return self.uptime_offset_ms + int(t * 1000)


class Simulator:
    """Helmet behaviour, separate from the network so tests can drive it directly.

    post(path, body) sends one request and returns the JSON reply, or None on failure.
    tick(t) does one second of work at sim time t (seconds since start).
    """

    def __init__(self, devices=3, fall_every=0.0, heat_ramp=0.0, resend=False,
                 post=None, rng=None, log=print):
        self.rng = rng or random.Random()
        self.helmets = [Helmet(f"sim-{i:02d}", self.rng) for i in range(1, devices + 1)]
        self.fall_every = fall_every
        self.next_fall = fall_every if fall_every > 0 else None
        self.heat_ramp = heat_ramp  # degrees C per minute
        self.resend = resend
        self.post = post
        self.log = log
        self.pending = []  # falls not yet accepted: dicts with helmet, event, retry_at

    def telemetry(self, h: Helmet, t: float) -> dict:
        r = self.rng
        temp = min(h.base_temp_c + self.heat_ramp * t / 60 + r.gauss(0, 0.15), MAX_TEMP_C)
        hum = min(max(h.humidity_pct + r.gauss(0, 0.5), 0.0), 100.0)
        lying_still = h.fallen_at is not None and t - h.fallen_at < STILL_AFTER_FALL_S
        if lying_still:
            accel, tilt = 1.0 + r.gauss(0, 0.01), r.uniform(80, 100)
        else:
            accel, tilt = 1.0 + r.gauss(0, 0.06), r.uniform(0, 25)
        return {
            "device_id": h.device_id,
            "uptime_ms": h.uptime_ms(t),
            "worn": True,
            "temp_c": round(temp, 1),
            "humidity_pct": round(hum, 1),
            "pressure_hpa": round(h.pressure_hpa + r.gauss(0, 0.05), 1),
            "heat_index_c": round(heat_index_c(temp, hum), 1),
            "accel_g": round(accel, 2),
            "tilt_deg": round(tilt, 1),
            "zone": None,
            "gps_fix": False,
            "lat": None,
            "lon": None,
        }

    def tick(self, t: float) -> None:
        for h in self.helmets:
            self.post("/api/telemetry", self.telemetry(h, t))  # dropped on failure, like the helmet
        if self.next_fall is not None and t >= self.next_fall:
            self.fall(self.rng.choice(self.helmets), t)
            self.next_fall += self.fall_every
        self.retry_pending(t)

    def fall(self, h: Helmet, t: float) -> None:
        h.fallen_at = t
        r = self.rng
        uptime = h.uptime_ms(t)
        event = {
            "device_id": h.device_id,
            "uptime_ms": uptime,
            "type": "fall",
            "peak_g": round(r.uniform(3.0, 8.0), 1),
            "freefall_ms": r.randint(150, 350),
            "still_s": round(r.uniform(2.0, 3.0), 1),
            "zone": None,
            "sent_uptime_ms": uptime,
        }
        reply = self.post("/api/event", event)
        if reply is None:
            self.log(f"{h.device_id}: fall not delivered, retrying every {RETRY_EVERY_S} s")
            self.pending.append({"helmet": h, "event": event, "retry_at": t + RETRY_EVERY_S})
            return
        incident_id = reply["incident_id"]
        self.log(f"{h.device_id}: fall -> incident {incident_id} (peak {event['peak_g']} g)")
        if self.resend:
            again = dict(event, sent_uptime_ms=uptime + 500)
            reply2 = self.post("/api/event", again)
            if reply2 is None:
                self.log(f"{h.device_id}: resend failed")
            elif reply2["incident_id"] == incident_id:
                self.log(f"{h.device_id}: resend -> same incident {incident_id} (no duplicate)")
            else:
                self.log(f"{h.device_id}: WARNING resend created incident {reply2['incident_id']}")

    def retry_pending(self, t: float) -> None:
        still_pending = []
        for p in self.pending:
            if t < p["retry_at"]:
                still_pending.append(p)
                continue
            h, event = p["helmet"], p["event"]
            event["sent_uptime_ms"] = h.uptime_ms(t)
            reply = self.post("/api/event", event)
            if reply is None:
                p["retry_at"] = t + RETRY_EVERY_S
                still_pending.append(p)
            else:
                late_s = (event["sent_uptime_ms"] - event["uptime_ms"]) / 1000
                self.log(f"{h.device_id}: fall delivered {late_s:.0f} s late -> incident {reply['incident_id']}")
        self.pending = still_pending


def http_poster(base_url: str, log=print, timeout_s: float = 3.0):
    """post(path, body) over HTTP. Logs when the server goes down or comes back, not every failure."""
    state = {"up": None}

    def post(path: str, body: dict):
        req = urllib.request.Request(
            base_url.rstrip("/") + path,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                reply = json.load(resp)
        except urllib.error.HTTPError as e:
            # The server answered but refused the message: a bug, so always show it.
            log(f"server rejected {path} ({e.code}): {e.read().decode(errors='replace')[:300]}")
            return None
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            if state["up"] is not False:
                log(f"cannot reach {base_url} ({e}); still trying")
            state["up"] = False
            return None
        if state["up"] is False:
            log(f"reconnected to {base_url}")
        state["up"] = True
        return reply

    return post


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Simulate WorkWear helmets (sim-01, sim-02, ...).")
    p.add_argument("--url", default="http://localhost:8000", help="server address (default %(default)s)")
    p.add_argument("--devices", type=int, default=3, help="number of helmets, 1-99 (default %(default)s)")
    p.add_argument("--fall-every", type=float, default=0, metavar="S",
                   help="send a fall from a random helmet every S seconds (default: never)")
    p.add_argument("--heat-ramp", type=float, default=0, metavar="C_PER_MIN",
                   help="raise temperature by this many degrees C per minute, up to 50 C (default: 0)")
    p.add_argument("--resend", action="store_true",
                   help="send every fall twice, to check the server does not duplicate it")
    p.add_argument("--duration", type=float, default=0, metavar="S", help="stop after S seconds (default: run until Ctrl+C)")
    p.add_argument("--seed", type=int, help="random seed, for repeatable runs")
    args = p.parse_args(argv)
    if not 1 <= args.devices <= 99:
        p.error("--devices must be 1-99")

    sim = Simulator(
        devices=args.devices, fall_every=args.fall_every, heat_ramp=args.heat_ramp,
        resend=args.resend, post=http_poster(args.url), rng=random.Random(args.seed),
    )
    ids = ", ".join(h.device_id for h in sim.helmets)
    print(f"Simulating {ids} -> {args.url}. Their incidents are marked sample data. Ctrl+C to stop.")

    start = time.monotonic()
    ticks = 0
    try:
        while True:
            t = time.monotonic() - start
            if args.duration and t >= args.duration:
                break
            sim.tick(t)
            ticks += 1
            time.sleep(max(0.0, start + ticks - time.monotonic()))  # about 1 Hz without drifting
    except KeyboardInterrupt:
        pass
    print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
