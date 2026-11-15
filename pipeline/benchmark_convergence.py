"""Deep numerical convergence and terrain/ephemeris sensitivity benchmark for Umbra-X.

Benchmarks 5 representative pads (Shackleton pad 481 & 181, Mons Mouton pad 17 & 481,
Malapert Massif pad 481) across:
1. Azimuth discretization convergence (0.25 deg, 0.5 deg vs 1.0 deg bins).
2. Regional terrain extent (48 km, 96 km, 120 km, 144 km) & 80m-only vs 20m+80m hybrid.
3. Temporal sampling (1-min vs 5-min) across all 43,201 minutes (30-day mission).
4. Finite solar disk (2D circular quadrature vs 1D straight-limb chord).
5. Mast height sensitivity (1.5 m, 3.0 m, 5.0 m, 10.0 m, 20.0 m).
6. Slope definition comparison (compiled dem_slope vs geodetic scale-corrected vs LOLA LDSM).
7. LOLA height-error sensitivity (0-sigma, 1-sigma, 2-sigma, 3-sigma).

Outputs machine-readable JSON to pipeline/benchmarks/convergence_benchmark.json.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from jplephem.daf import DAF
from jplephem.pck import PCK
from numba import njit
import numpy as np
import rasterio
from skyfield.api import PlanetaryConstants, load, load_file

from fetch_nasa_data import CACHE, compute_geodetic_slope
from umbra_x.compiler import MASTS, PIXEL, RADIUS, read_tile
from validate_ephemeris import lunar_basis

ROOT = Path(__file__).resolve().parent.parent
RELEASE_DIR = ROOT / "web" / "public" / "data" / "planner-release"
LDEM_80M_PATH = CACHE / "LDEM_80S_80MPP_ADJ.TIF"
BENCHMARK_OUT = Path(__file__).resolve().parent / "benchmarks" / "convergence_benchmark.json"

SOLAR_RADIUS_DEG = 0.2665
SOLAR_THRESHOLD = 0.1
FRAME = "MOON_ME_DE440_ME421"

BENCHMARK_PADS = [
    ("shackleton-ridge", "shackleton_ridge", 480),
    ("shackleton-ridge", "shackleton_ridge", 478),
    ("shackleton-ridge", "shackleton_ridge", 180),
    ("mons-mouton", "mons_mouton", 16),
    ("mons-mouton", "mons_mouton", 480),
    ("malapert-massif", "malapert_massif", 480),
]


@njit(cache=True)
def _bilinear(grid: np.ndarray, left: float, top: float, pix: float, x: float, y: float) -> float:
    col = (x - left) / pix - 0.5
    row = (top - y) / pix - 0.5
    rows, cols = grid.shape
    if row < 0.0 or row >= rows - 1.0 or col < 0.0 or col >= cols - 1.0:
        return np.nan
    r = int(row)
    c = int(col)
    fy = row - r
    fx = col - c
    v00 = grid[r, c]
    v01 = grid[r, c + 1]
    v10 = grid[r + 1, c]
    v11 = grid[r + 1, c + 1]
    if not (np.isfinite(v00) and np.isfinite(v01) and np.isfinite(v10) and np.isfinite(v11)):
        return np.nan
    return (1.0 - fy) * ((1.0 - fx) * v00 + fx * v01) + fy * ((1.0 - fx) * v10 + fx * v11)


@njit(cache=True)
def raymarch_pad_hybrid(
    local_dem: np.ndarray,
    local_left: float,
    local_top: float,
    local_pix: float,
    local_bounds: tuple,
    reg_dem: np.ndarray,
    reg_left: float,
    reg_top: float,
    reg_pix: float,
    lat_deg: float,
    lon_deg: float,
    base_elev_m: float,
    mast_m: float,
    max_dist_m: float,
    az_count: int,
    use_hybrid: bool,
):
    """Spherical-Moon geodesic raymarch across 20m local tile + 80m regional DEM."""
    west, south, east, north = local_bounds
    lt = np.deg2rad(lat_deg)
    ln = np.deg2rad(lon_deg)
    sl, cl = np.sin(lt), np.cos(lt)
    sn, cn = np.sin(ln), np.cos(ln)
    r0 = RADIUS + base_elev_m + mast_m
    horizons = np.full(az_count, -90.0, dtype=np.float64)

    for ai in range(az_count):
        az = 2.0 * np.pi * ai / az_count
        sa, ca = np.sin(az), np.cos(az)
        best_sin = -1.0
        best_el = -90.0

        # Near-field 20 m local march up to 1800 m (matching umbra_x/compiler.py step=20m)
        if use_hybrid:
            d = local_pix
            while d <= 1800.0 and d <= max_dist_m:
                ang = d / RADIUS
                sin_a, cos_a = np.sin(ang), np.cos(ang)
                p_lat = np.arcsin(min(1.0, max(-1.0, sl * cos_a + cl * sin_a * ca)))
                p_lon = ln + np.arctan2(sa * sin_a * cl, cos_a - sl * np.sin(p_lat))
                rho = 2.0 * RADIUS * np.tan((np.pi / 2.0 + p_lat) / 2.0)
                px = rho * np.sin(p_lon)
                py = rho * np.cos(p_lon)
                if west <= px <= east and south <= py <= north:
                    z = _bilinear(local_dem, local_left, local_top, local_pix, px, py)
                    if np.isfinite(z):
                        rp = RADIUS + z
                        chord_sq = rp * rp + r0 * r0 - 2.0 * rp * r0 * cos_a
                        if chord_sq > 0.0:
                            s_el = (rp * cos_a - r0) / np.sqrt(chord_sq)
                            if s_el > best_sin:
                                best_sin = s_el
                                best_el = np.rad2deg(np.arcsin(min(1.0, max(-1.0, s_el))))
                d += local_pix

        # Regional 80 m march beyond local boundary (with 160m overlap when hybrid=True)
        d = 80.0
        step = 80.0
        while d <= max_dist_m:
            ang = d / RADIUS
            sin_a, cos_a = np.sin(ang), np.cos(ang)
            p_lat = np.arcsin(min(1.0, max(-1.0, sl * cos_a + cl * sin_a * ca)))
            p_lon = ln + np.arctan2(sa * sin_a * cl, cos_a - sl * np.sin(p_lat))
            rho = 2.0 * RADIUS * np.tan((np.pi / 2.0 + p_lat) / 2.0)
            px = rho * np.sin(p_lon)
            py = rho * np.cos(p_lon)

            inside_local = (west + 160.0 <= px <= east - 160.0) and (south + 160.0 <= py <= north - 160.0)
            if (not use_hybrid) or (not inside_local):
                # Maximum possible angle guard above -89.9 deg not needed for small test batch
                z = _bilinear(reg_dem, reg_left, reg_top, reg_pix, px, py)
                if np.isfinite(z):
                    rp = RADIUS + z
                    chord_sq = rp * rp + r0 * r0 - 2.0 * rp * r0 * cos_a
                    if chord_sq > 0.0:
                        s_el = (rp * cos_a - r0) / np.sqrt(chord_sq)
                        if s_el > best_sin:
                            best_sin = s_el
                            best_el = np.rad2deg(np.arcsin(min(1.0, max(-1.0, s_el))))
            d += step
        horizons[ai] = best_el
    return horizons


def disk_fraction_1d(sun_el: np.ndarray, hor_el: np.ndarray, radius: float = SOLAR_RADIUS_DEG) -> np.ndarray:
    d = (sun_el - hor_el) / radius
    out = np.zeros_like(d, dtype=np.float64)
    out[d >= 1.0] = 1.0
    mid = (d > -1.0) & (d < 1.0)
    dm = np.clip(d[mid], -1.0, 1.0)
    out[mid] = 0.5 + (dm * np.sqrt(np.maximum(0.0, 1.0 - dm * dm)) + np.arcsin(dm)) / np.pi
    return out


def disk_fraction_2d_true_horizon(
    sun_az: np.ndarray, sun_el: np.ndarray, horizons_fine: np.ndarray, radius: float = SOLAR_RADIUS_DEG
) -> np.ndarray:
    """2D quadrature over the circular solar disk evaluated against true curved az-varying horizon."""
    # Precompute 317 quadrature points inside unit disk.
    pts = []
    n = 10
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            x = i / n
            y = j / n
            if x * x + y * y <= 1.0:
                pts.append((x * radius, y * radius))
    pts = np.asarray(pts, dtype=np.float64)
    d_az_off = pts[:, 0]  # scaled below by 1 / cos(el) or directly at near-0 polar sun el (~1.5 deg -> cos~1)
    d_el_off = pts[:, 1]
    az_count = len(horizons_fine)
    cos_el = np.maximum(0.1, np.cos(np.deg2rad(sun_el)))[:, None]
    az_pts = (sun_az[:, None] + d_az_off[None, :] / cos_el) % 360.0
    el_pts = sun_el[:, None] + d_el_off[None, :]
    # Linear interpolation of horizon in azimuth
    pos = az_pts * (az_count / 360.0)
    i0 = np.floor(pos).astype(np.int64) % az_count
    i1 = (i0 + 1) % az_count
    f = pos - np.floor(pos)
    h_pts = horizons_fine[i0] * (1.0 - f) + horizons_fine[i1] * f
    return np.mean(el_pts > h_pts, axis=1)


def interp_horizon(horizons: np.ndarray, az_deg: np.ndarray) -> np.ndarray:
    n = len(horizons)
    pos = (az_deg % 360.0) * (n / 360.0)
    i0 = np.floor(pos).astype(np.int64) % n
    i1 = (i0 + 1) % n
    f = pos - np.floor(pos)
    return horizons[i0] * (1.0 - f) + horizons[i1] * f


def max_outage_hours(mask_true: np.ndarray, step_hours: float) -> float:
    best = 0
    cur = 0
    for ok in mask_true:
        if not ok:
            cur += 1
            if cur > best:
                best = cur
        else:
            cur = 0
    return best * step_hours


def pad_az_el(vecs: np.ndarray, lat: float, lon: float, height_m: float, mast_m: float):
    east, north, up = lunar_basis(lat, lon)
    obs = up * (RADIUS + height_m + mast_m)
    out = {}
    for name, sl in (("sun", slice(0, 3)), ("earth", slice(3, 6))):
        rel = vecs[:, sl] - obs[None, :]
        e = rel @ east
        n = rel @ north
        u = rel @ up
        r = np.sqrt(e * e + n * n + u * u)
        az = np.degrees(np.arctan2(e, n)) % 360.0
        el = np.degrees(np.arcsin(np.clip(u / r, -1.0, 1.0)))
        out[name] = (az, el)
    return out


def eval_mission_metrics(az_el: dict, horizons: np.ndarray, step_hours: float, sigma_mult: float = 0.0, horizon_sigma: np.ndarray | None = None):
    h_sun = horizons if horizon_sigma is None or sigma_mult == 0.0 else horizons + sigma_mult * interp_horizon(horizon_sigma, np.arange(len(horizons)) * (360.0 / len(horizons)))
    hs_sun = interp_horizon(h_sun, az_el["sun"][0])
    hs_earth = interp_horizon(h_sun, az_el["earth"][0])
    sfrac = disk_fraction_1d(az_el["sun"][1], hs_sun)
    lit = sfrac >= SOLAR_THRESHOLD
    earth_ok = az_el["earth"][1] > hs_earth
    return {
        "solarHours": round(float(np.sum(lit) * step_hours), 3),
        "longestDarkHours": round(max_outage_hours(lit, step_hours), 3),
        "earthHours": round(float(np.sum(earth_ok) * step_hours), 3),
        "longestEarthOutageHours": round(max_outage_hours(earth_ok, step_hours), 3),
    }


def compute_1min_vectors(kernels_dir: Path, start_dt: datetime, total_minutes: int) -> np.ndarray:
    """Evaluate apparent Sun/Earth vectors using the same conventions as the release."""
    constants = PlanetaryConstants()
    for name in ("moon_de440_250416.tf", "pck00011.tpc"):
        with (kernels_dir / name).open("rb") as stream:
            constants.read_text(stream)
    dates = [start_dt + timedelta(minutes=i) for i in range(total_minutes + 1)]
    times = load.timescale().from_datetimes(dates)
    out = np.empty((len(dates), 6), dtype=np.float64)
    remaining = np.ones(len(dates), dtype=bool)
    with (kernels_dir / "moon_pa_de440_200625.bpc").open("rb") as stream, closing(
        load_file(str(kernels_dir / "de440s.bsp"))
    ) as planets:
        frame_id = constants.variables[f"FRAME_{FRAME}"]
        relative = constants.variables[f"TKFRAME_{frame_id}_RELATIVE"]
        relative_id = constants.variables[f"FRAME_{relative}"]
        for segment in reversed(PCK(DAF(stream)).segments):
            if segment.body != relative_id:
                continue
            mask = remaining & (segment.initial_jd <= times.tdb) & (times.tdb <= segment.final_jd)
            if not mask.any():
                continue
            t = times[mask]
            frame = constants.build_frame(frame_id, _segment=segment)
            moon_at = planets["moon"].at(t)
            out[mask, 0:3] = moon_at.observe(planets["sun"]).apparent().frame_xyz(frame).m.T
            out[mask, 3:6] = moon_at.observe(planets["earth"]).apparent().frame_xyz(frame).m.T
            remaining[mask] = False
    if remaining.any():
        raise ValueError("Kernels do not cover 1-minute mission window")
    return out


def run_benchmark() -> dict:
    with rasterio.open(LDEM_80M_PATH) as src:
        reg_dem = src.read(1).astype(np.float32)
        reg_dem = np.where(np.isfinite(reg_dem) & (reg_dem > -32000), reg_dem, np.nan)
        reg_left = float(src.transform.c)
        reg_top = float(src.transform.f)
        reg_pix = float(src.transform.a)

    sample_planner = json.loads((RELEASE_DIR / "shackleton-ridge" / "planner.json").read_text(encoding="utf-8"))
    start_dt = datetime.fromisoformat(sample_planner["start"]).replace(tzinfo=timezone.utc)
    vhash = sample_planner["vectorHash"]
    vecs_5m = np.frombuffer((RELEASE_DIR / "planner" / f"{vhash}.bin").read_bytes(), dtype="<f8").reshape(-1, 12)
    vecs_1m = compute_1min_vectors(CACHE / "kernels", start_dt, (len(vecs_5m) - 1) * 5)
    np.testing.assert_allclose(vecs_1m[::5], vecs_5m[:, :6], rtol=1e-12, atol=0.01)

    results = []
    for release_site, cache_site, node in BENCHMARK_PADS:
        sdir = RELEASE_DIR / release_site
        planner = json.loads((sdir / "planner.json").read_text(encoding="utf-8"))
        lat, lon, base_h = planner["observers"][node]

        npz = np.load(CACHE / f"{cache_site}_terrain.npz")
        local_dem = npz["dem_elev"].astype(np.float32)
        t_vals = npz["transform"]
        from rasterio.transform import Affine
        affine = Affine(*t_vals[:6])
        local_left = float(affine.c)
        local_top = float(affine.f)
        local_pix = float(affine.a)
        west, north = affine * (0.5, 0.5)
        east, south = affine * (255.5, 255.5)
        local_bounds = (float(west), float(south), float(east), float(north))

        # Compiled release binaries for verification & sigma values.
        reg_bin = np.frombuffer((RELEASE_DIR / "planner" / f"{planner['regional']['regional']}.bin").read_bytes(), dtype="<f4").reshape(-1, 5, 360)
        herr_bin = np.frombuffer((sdir / "horizons_err.bin").read_bytes(), dtype="<f4").reshape(-1, 360)
        rel_hor_5m = reg_bin[node, 2, :].astype(np.float64)
        hor_sigma = herr_bin[node, :].astype(np.float64)

        # The terminal timestamp has no following interval in the catalog.
        az_el_5m = pad_az_el(vecs_5m[:-1, 0:6], lat, lon, base_h, 5.0)
        az_el_1m = pad_az_el(vecs_1m[:-1], lat, lon, base_h, 5.0)

        # 1. Azimuth discretization convergence at 96 km hybrid (default 5m mast).
        h_1440 = raymarch_pad_hybrid(local_dem, local_left, local_top, local_pix, local_bounds, reg_dem, reg_left, reg_top, reg_pix, lat, lon, base_h, 5.0, 96000.0, 1440, True)
        h_720 = raymarch_pad_hybrid(local_dem, local_left, local_top, local_pix, local_bounds, reg_dem, reg_left, reg_top, reg_pix, lat, lon, base_h, 5.0, 96000.0, 720, True)
        h_360 = raymarch_pad_hybrid(local_dem, local_left, local_top, local_pix, local_bounds, reg_dem, reg_left, reg_top, reg_pix, lat, lon, base_h, 5.0, 96000.0, 360, True)

        # Verify 360-bin raymarch vs compiled release binary.
        release_vs_raymarch_mae = float(np.mean(np.abs(h_360 - rel_hor_5m)))
        m_360 = eval_mission_metrics(az_el_5m, h_360, 5.0 / 60.0)
        m_720 = eval_mission_metrics(az_el_5m, h_720, 5.0 / 60.0)
        m_1440 = eval_mission_metrics(az_el_5m, h_1440, 5.0 / 60.0)
        interp_360_at_050 = interp_horizon(h_360, np.arange(720) * 0.5)
        interp_360_at_025 = interp_horizon(h_360, np.arange(1440) * 0.25)
        diff_050_vs_interp = np.abs(h_720 - interp_360_at_050)
        diff_025_vs_interp = np.abs(h_1440 - interp_360_at_025)

        # 2. Extent convergence (48, 96, 120, 144 km) + 80m-only vs hybrid.
        extent_metrics = {}
        ext_horizons = {}
        for km in (48, 96, 120, 144):
            hk = raymarch_pad_hybrid(local_dem, local_left, local_top, local_pix, local_bounds, reg_dem, reg_left, reg_top, reg_pix, lat, lon, base_h, 5.0, km * 1000.0, 360, True)
            ext_horizons[km] = hk
            extent_metrics[f"{km}km"] = {
                **eval_mission_metrics(az_el_5m, hk, 5.0 / 60.0),
                "maxDeltaVs96kmDeg": round(float(np.max(np.abs(hk - ext_horizons[96]))) if 96 in ext_horizons else 0.0, 4),
            }
        # Recompute exact maxDeltaVs96kmDeg after loop so 48km compares against 96km too.
        for km in (48, 96, 120, 144):
            d96 = np.abs(ext_horizons[km] - ext_horizons[96])
            extent_metrics[f"{km}km"]["maxDeltaVs96kmDeg"] = round(float(np.max(d96)), 4)
            extent_metrics[f"{km}km"]["binsGt0p05DegVs96km"] = int(np.sum(d96 > 0.05))

        h_80m_only = raymarch_pad_hybrid(local_dem, local_left, local_top, local_pix, local_bounds, reg_dem, reg_left, reg_top, reg_pix, lat, lon, base_h, 5.0, 96000.0, 360, False)
        diff_80_vs_hybrid = np.abs(h_80m_only - h_360)
        m_80m = eval_mission_metrics(az_el_5m, h_80m_only, 5.0 / 60.0)

        # 3. Temporal sampling: 1-min vs 5-min.
        m_1min = eval_mission_metrics(az_el_1m, h_360, 1.0 / 60.0)

        # 4. 2D solar disk quadrature vs 1D straight-limb chord at 5-min.
        s1d = disk_fraction_1d(az_el_5m["sun"][1], interp_horizon(h_1440, az_el_5m["sun"][0]))
        s2d = disk_fraction_2d_true_horizon(az_el_5m["sun"][0], az_el_5m["sun"][1], h_1440)
        solar_hours_1d = float(np.sum(s1d > SOLAR_THRESHOLD) * (5.0 / 60.0))
        solar_hours_2d = float(np.sum(s2d > SOLAR_THRESHOLD) * (5.0 / 60.0))
        dark_1d = max_outage_hours(s1d > SOLAR_THRESHOLD, 5.0 / 60.0)
        dark_2d = max_outage_hours(s2d > SOLAR_THRESHOLD, 5.0 / 60.0)

        # 5. Mast sweep (1.5, 3, 5, 10, 20 m).
        mast_sweep = {}
        for mi, mast in enumerate(MASTS):
            az_el_m = pad_az_el(vecs_5m[:, 0:6], lat, lon, base_h, float(mast))
            hm = reg_bin[node, mi, :].astype(np.float64)
            mast_sweep[f"{mast}m"] = eval_mission_metrics(az_el_m, hm, 5.0 / 60.0)

        # 6. Slope definitions at this pad (row, col from node index 31x31 analysis grid).
        grid = json.loads((sdir / "manifest.json").read_text(encoding="utf-8"))["analysis_grid"]
        r_px = grid["start_pixel"] + (node // grid["cols"]) * grid["step_pixel"]
        c_px = grid["start_pixel"] + (node % grid["cols"]) * grid["step_pixel"]
        compiled_slope_deg = float(npz["dem_slope"][r_px, c_px])
        geodetic_slope_deg = float(compute_geodetic_slope(local_dem, affine)[r_px, c_px])
        lola_ldsm_deg = float(npz["lola_slope"][r_px, c_px])

        # 7. Height uncertainty sigma sweep (0, 1, 2, 3 sigma).
        sigma_sweep = {}
        for sig in (0, 1, 2, 3):
            hs_sun = interp_horizon(rel_hor_5m, az_el_5m["sun"][0]) + sig * interp_horizon(hor_sigma, az_el_5m["sun"][0])
            hs_earth = interp_horizon(rel_hor_5m, az_el_5m["earth"][0]) + sig * interp_horizon(hor_sigma, az_el_5m["earth"][0])
            lit = disk_fraction_1d(az_el_5m["sun"][1], hs_sun) > SOLAR_THRESHOLD
            eok = az_el_5m["earth"][1] > hs_earth
            sigma_sweep[f"{sig}sigma"] = {
                "solarHours": round(float(np.sum(lit) * (5.0 / 60.0)), 3),
                "longestDarkHours": round(max_outage_hours(lit, 5.0 / 60.0), 3),
                "earthHours": round(float(np.sum(eok) * (5.0 / 60.0)), 3),
                "longestEarthOutageHours": round(max_outage_hours(eok, 5.0 / 60.0), 3),
                "medianHorizonSigmaDeg": round(float(np.median(hor_sigma)), 4),
            }

        mission_windows = []
        if release_site == "shackleton-ridge" and node in (480, 478):
            for start_hour in ((0, 48) if node == 480 else (48,)):
                first = start_hour * 12
                last = first + 15 * 24 * 12
                window = {body: (az[first:last], el[first:last]) for body, (az, el) in az_el_5m.items()}
                fine_first = start_hour * 60
                fine_last = fine_first + 15 * 24 * 60
                fine_window = {body: (az[fine_first:fine_last], el[fine_first:fine_last]) for body, (az, el) in az_el_1m.items()}
                mission_windows.append({
                    "startHours": start_hour,
                    "days": 15,
                    "mastM": 5,
                    "solarThreshold": SOLAR_THRESHOLD,
                    "vectorHash": vhash,
                    "fixedDiskOnRelease96km": eval_mission_metrics(window, rel_hor_5m, 1 / 12),
                    "extentMetrics": {str(km): eval_mission_metrics(window, ext_horizons[km], 1 / 12) for km in (48, 96, 144)},
                    "height2Sigma": eval_mission_metrics(window, rel_hor_5m, 1 / 12, 2, hor_sigma),
                    "quarterDegree": eval_mission_metrics(window, h_1440, 1 / 12),
                    "oneMinute": eval_mission_metrics(fine_window, h_360, 1 / 60),
                    "verificationStatus": "numerical_comparison_only_coverage_not_certified",
                })

        results.append({
            "missionWindows": mission_windows,
            "site": release_site,
            "node": node,
            "pad": node + 1,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "heightM": round(base_h, 2),
            "releaseVsRaymarchMaeDeg": round(release_vs_raymarch_mae, 5),
            "azimuthConvergence": {
                "deg1_00": m_360,
                "deg0_50": {
                    **m_720,
                    "horizonMaeVs1_00InterpDeg": round(float(np.mean(diff_050_vs_interp)), 5),
                    "maxElDeltaVs1_00InterpDeg": round(float(np.max(diff_050_vs_interp)), 4),
                },
                "deg0_25": {
                    **m_1440,
                    "horizonMaeVs1_00InterpDeg": round(float(np.mean(diff_025_vs_interp)), 5),
                    "maxElDeltaVs1_00InterpDeg": round(float(np.max(diff_025_vs_interp)), 4),
                },
            },
            "extentConvergence": extent_metrics,
            "terrain80mOnlyVsHybrid": {
                "horizonMaeDeg": round(float(np.mean(diff_80_vs_hybrid)), 4),
                "horizonMaxDeltaDeg": round(float(np.max(diff_80_vs_hybrid)), 4),
                "binsGt0p5Deg": int(np.sum(diff_80_vs_hybrid > 0.5)),
                "metrics80mOnly": m_80m,
            },
            "temporalSampling": {
                "step5min": m_360,
                "step1min": m_1min,
                "deltaSolarHours": round(m_1min["solarHours"] - m_360["solarHours"], 3),
                "deltaLongestDarkHours": round(m_1min["longestDarkHours"] - m_360["longestDarkHours"], 3),
                "deltaLongestEarthHours": round(m_1min["longestEarthOutageHours"] - m_360["longestEarthOutageHours"], 3),
            },
            "solarDiskModel": {
                "straightLimb1d": {"solarHours": round(solar_hours_1d, 3), "longestDarkHours": round(dark_1d, 3)},
                "circular2d": {"solarHours": round(solar_hours_2d, 3), "longestDarkHours": round(dark_2d, 3)},
                "maxFracDiff": round(float(np.max(np.abs(s2d - s1d))), 4),
            },
            "mastSweep": mast_sweep,
            "slopeComparison": {
                "compiledPlanarDeg": round(compiled_slope_deg, 4),
                "geodeticScaleCorrectedDeg": round(geodetic_slope_deg, 4),
                "lolaLdsmOfficialDeg": round(lola_ldsm_deg, 4),
            },
            "sigmaSensitivity": sigma_sweep,
        })

    output = {
        "schema": 2,
        "vectorHash": vhash,
        "benchmarkNote": "Fixed solar disk, no eclipse attenuation. Numerical terrain sensitivity, not the exact browser power model or observational validation.",
        "padCount": len(results),
        "pads": results,
    }
    BENCHMARK_OUT.parent.mkdir(parents=True, exist_ok=True)
    BENCHMARK_OUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    return output


def main():
    out = run_benchmark()
    for p in out["pads"]:
        az = p["azimuthConvergence"]
        ext = p["extentConvergence"]
        t80 = p["terrain80mOnlyVsHybrid"]
        sl = p["slopeComparison"]
        sg = p["sigmaSensitivity"]
        print(f"{p['site']} pad {p['pad']} (node {p['node']}): rel_mae={p['releaseVsRaymarchMaeDeg']}° | "
              f"az0.25 maxd={az['deg0_25']['maxElDeltaVs1_00InterpDeg']}° (mae={az['deg0_25']['horizonMaeVs1_00InterpDeg']}°) dark(1.0->0.25)={az['deg1_00']['longestDarkHours']}->{az['deg0_25']['longestDarkHours']}h | "
              f"ext(48/96/144) dark={ext['48km']['longestDarkHours']}/{ext['96km']['longestDarkHours']}/{ext['144km']['longestDarkHours']}h | "
              f"80m maxd={t80['horizonMaxDeltaDeg']}° | "
              f"slope(comp/geod/LDSM)={sl['compiledPlanarDeg']}/{sl['geodeticScaleCorrectedDeg']}/{sl['lolaLdsmOfficialDeg']}° | "
              f"0s->3s dark={sg['0sigma']['longestDarkHours']}->{sg['3sigma']['longestDarkHours']}h")


if __name__ == "__main__":
    main()
