"""Heat index -> heat_level, using the NWS bands in docs/PROTOCOL.md section 7.

This is heat *risk* from ambient conditions at the helmet, not heat stress.
"""

# (upper limit, level): a heat index below the limit gets that level.
BANDS = [
    (27.0, "normal"),
    (32.0, "caution"),
    (39.0, "extreme_caution"),
    (51.0, "danger"),
]


def heat_level(heat_index_c: float | None) -> str | None:
    if heat_index_c is None:
        return None
    for limit, level in BANDS:
        if heat_index_c < limit:
            return level
    return "extreme_danger"
