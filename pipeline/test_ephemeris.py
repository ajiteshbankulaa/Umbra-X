"""Compare Skyfield DE440 with NASA/JPL topocentric observer tables."""

from datetime import datetime
import json

import numpy as np
import pytest

from fetch_nasa_data import APOLLO, BODIES, CACHE, POLAR_SITES, STEPS, dates_from, iso, skyfield_angles


@pytest.mark.parametrize("site", (*POLAR_SITES, APOLLO), ids=lambda site: site.id)
def test_skyfield_matches_horizons(site):
    path = CACHE / f"{site.id}_ephemeris.json"
    if not path.exists():
        pytest.skip("Run fetch_nasa_data.py to cache the NASA comparison data")
    reference = json.loads(path.read_text(encoding="utf-8"))
    dates = dates_from(datetime.fromisoformat(reference["start_utc"]))
    assert reference["timestamps"] == [iso(date) for date in dates]
    calculated = skyfield_angles(CACHE / "kernels", site, dates)
    for body in BODIES:
        azimuth, elevation = calculated[body]
        ref_az = np.asarray(reference[f"{body}_az_deg"])
        ref_el = np.asarray(reference[f"{body}_el_deg"])
        assert ref_az.shape == ref_el.shape == (STEPS,)
        azimuth_error = (azimuth - ref_az + 180) % 360 - 180
        np.testing.assert_allclose(azimuth_error, 0, atol=0.05, err_msg=f"{body} azimuth")
        np.testing.assert_allclose(elevation - ref_el, 0, atol=0.05, err_msg=f"{body} elevation")
