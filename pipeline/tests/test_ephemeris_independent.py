"""Regression tests validating planner ephemeris & DSN orientation on withheld non-center pads."""
from pathlib import Path
import sys

PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from validate_ephemeris import run_validation  # noqa: E402


def test_withheld_pads_and_polar_extreme_against_cached_horizons():
    report = run_validation(offline=True)
    assert report["targetCount"] == 15
    target_ids = {t["id"] for t in report["targets"]}
    assert "shackleton-ridge:node-0" in target_ids
    assert "shackleton-ridge:node-960" in target_ids
    assert "mons-mouton:node-16" in target_ids
    assert "malapert-massif:node-216" in target_ids
    assert "polar-extreme-89.9S" in target_ids

    vp = report["vectorsBinParity"]
    assert vp["sunMaxPositionDiffMeters"] < 1e-5
    assert vp["earthMaxPositionDiffMeters"] < 1e-5
    assert vp["dss14MaxPositionDiffMeters"] < 1e-5
    assert vp["dss14MaxNormalDiffUnit"] < 1e-12
    assert vp["dss14MaxLunarElevationDiffDeg"] < 1e-8

    mr = report["maxResiduals"]
    # Compiled apparent (LT+S) vectors.bin and Skyfield apparent both agree with JPL Horizons AIRLESS to < 0.0001 deg.
    assert mr["sun_app_vs_horizons_sep_deg"] < 0.0001
    assert mr["earth_app_vs_horizons_sep_deg"] < 0.0001
    assert mr["sun_bin_vs_horizons_sep_deg"] < 0.0001
    assert mr["earth_bin_vs_horizons_sep_deg"] < 0.0001
    assert mr["sun_aberration_deg"] > 0.005
