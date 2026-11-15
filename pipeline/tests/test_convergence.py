"""Deterministic convergence and physical-sensitivity regression tests."""
import json
from pathlib import Path
import sys

import numpy as np

PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from benchmark_convergence import (  # noqa: E402
    disk_fraction_1d,
    disk_fraction_2d_true_horizon,
    interp_horizon,
    raymarch_pad_hybrid,
)
from umbra_x.compiler import RADIUS  # noqa: E402


def test_2d_solar_disk_matches_1d_on_flat_horizon_and_diverges_on_notch():
    # On a flat horizon (0 deg everywhere), 2D quadrature and 1D chord agree tightly.
    flat = np.zeros(1440, dtype=np.float64)
    az = np.array([45.0, 90.0, 180.0])
    el = np.array([0.0, 0.13325, -0.13325])
    f1 = disk_fraction_1d(el, interp_horizon(flat, az))
    f2 = disk_fraction_2d_true_horizon(az, el, flat)
    assert np.max(np.abs(f1 - f2)) < 0.05

    # On a sub-solar-width notch (0.25 deg spire at az=90.0 deg), 2D integration sees side lobes.
    notch = np.zeros(1440, dtype=np.float64)
    notch[360] = 2.0  # 0.25 deg narrow spire vs 0.533 deg solar diameter
    f1_notch = disk_fraction_1d(np.array([0.5]), interp_horizon(notch, np.array([90.0])))[0]
    f2_notch = disk_fraction_2d_true_horizon(np.array([90.0]), np.array([0.5]), notch)[0]
    assert f1_notch == 0.0
    assert f2_notch > 0.10


def test_azimuth_discretization_and_hybrid_near_field_sensitivity():
    # Build synthetic 20m local tile + 80m regional flat bed around Malapert-like site.
    lat_deg, lon_deg = -86.0, 2.0
    lt, ln = np.deg2rad(lat_deg), np.deg2rad(lon_deg)
    rho = 2.0 * RADIUS * np.tan((np.pi / 2.0 + lt) / 2.0)
    x0, y0 = rho * np.sin(ln), rho * np.cos(ln)

    pix_loc = 20.0
    n_loc = 128
    left_loc = x0 - (n_loc / 2.0) * pix_loc
    top_loc = y0 + (n_loc / 2.0) * pix_loc
    local_dem = np.zeros((n_loc, n_loc), dtype=np.float32)

    # Place a sub-grid narrow 20m-wide spire 200 m east at az ~ 90.35 deg (between 90 and 91 deg)
    lt_e = np.deg2rad(lat_deg)
    c_sp = int(round((x0 + 200.0 - left_loc) / pix_loc - 0.5))
    r_sp = int(round((top_loc - (y0 - 2.0)) / pix_loc - 0.5))
    local_dem[r_sp, c_sp] = 35.0
    local_bounds = (
        left_loc + 0.5 * pix_loc,
        top_loc - (n_loc - 0.5) * pix_loc,
        left_loc + (n_loc - 0.5) * pix_loc,
        top_loc - 0.5 * pix_loc,
    )

    pix_reg = 80.0
    n_reg = 64
    left_reg = x0 - (n_reg / 2.0) * pix_reg
    top_reg = y0 + (n_reg / 2.0) * pix_reg
    reg_dem = np.zeros((n_reg, n_reg), dtype=np.float32)

    h_360 = raymarch_pad_hybrid(local_dem, left_loc, top_loc, pix_loc, local_bounds, reg_dem, left_reg, top_reg, pix_reg, lat_deg, lon_deg, 0.0, 1.5, 1600.0, 360, True)
    h_1440 = raymarch_pad_hybrid(local_dem, left_loc, top_loc, pix_loc, local_bounds, reg_dem, left_reg, top_reg, pix_reg, lat_deg, lon_deg, 0.0, 1.5, 1600.0, 1440, True)
    h_80_only = raymarch_pad_hybrid(local_dem, left_loc, top_loc, pix_loc, local_bounds, reg_dem, left_reg, top_reg, pix_reg, lat_deg, lon_deg, 0.0, 1.5, 1600.0, 360, False)

    assert np.max(h_1440) > np.max(h_360)
    assert np.max(h_360) > np.max(h_80_only) + 3.5


def test_saved_convergence_benchmark_invariants():
    bench = Path(__file__).resolve().parents[1] / "benchmarks" / "convergence_benchmark.json"
    assert bench.exists(), "Run pipeline/benchmark_convergence.py to populate convergence_benchmark.json"
    data = json.loads(bench.read_text(encoding="utf-8"))
    assert data["padCount"] == len(data["pads"])
    demonstration = next(p for p in data["pads"] if p["site"] == "shackleton-ridge" and p["pad"] == 479)
    assert demonstration["missionWindows"][0]["startHours"] == 48
    assert demonstration["missionWindows"][0]["days"] == 15
    for p in data["pads"]:
        assert p["releaseVsRaymarchMaeDeg"] < 0.02
        sig = p["sigmaSensitivity"]
        # Higher positive terrain uncertainty cannot shrink longest darkness or increase total sun.
        assert sig["3sigma"]["longestDarkHours"] >= sig["0sigma"]["longestDarkHours"]
        assert sig["3sigma"]["solarHours"] <= sig["0sigma"]["solarHours"]
        # Higher mast cannot increase longest darkness for the same terrain.
        masts = p["mastSweep"]
        assert masts["20.0m"]["longestDarkHours"] <= masts["1.5m"]["longestDarkHours"]
