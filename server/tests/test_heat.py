import pytest

from app.heat import heat_level


@pytest.mark.parametrize(
    "heat_index_c, expected",
    [
        (None, None),
        (10.0, "normal"),
        (26.99, "normal"),
        (27.0, "caution"),
        (31.99, "caution"),
        (32.0, "extreme_caution"),
        (38.99, "extreme_caution"),
        (39.0, "danger"),
        (50.99, "danger"),
        (51.0, "extreme_danger"),
        (60.0, "extreme_danger"),
    ],
)
def test_heat_level_bands(heat_index_c, expected):
    assert heat_level(heat_index_c) == expected
