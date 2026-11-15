"""Scoped on-demand LRO LOLA 80S-90S terrain raytracer and extent/latency benchmark."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from time import perf_counter

from numba import njit
import numpy as np
import rasterio

from umbra_x.compiler import RADIUS

DEFAULT_TIF = Path(__file__).resolve().parent / "cache" / "LDEM_80S_80MPP_ADJ.TIF"


@njit(cache=True)
def _march_point(terrain, left, top, pixel_size, lat_deg, lon_deg, mast_m, max_dist_m, step_m):
    height_rows, width_cols = terrain.shape
    lt = np.deg2rad(lat_deg)
    ln = np.deg2rad(lon_deg)

    rho0 = 2.0 * RADIUS * np.tan((np.pi / 2.0 + lt) / 2.0)
    col0 = (rho0 * np.sin(ln) - left) / pixel_size - 0.5
    row0 = (top - rho0 * np.cos(ln)) / pixel_size - 0.5
    if not (1.0 <= row0 < height_rows - 2.0 and 1.0 <= col0 < width_cols - 2.0):
        raise ValueError("Coordinate lies outside LDEM_80S_80MPP_ADJ raster footprint.")

    r0 = int(row0)
    c0 = int(col0)
    fy0 = row0 - r0
    fx0 = col0 - c0
    base = (
        (1.0 - fy0) * ((1.0 - fx0) * terrain[r0, c0] + fx0 * terrain[r0, c0 + 1])
        + fy0 * ((1.0 - fx0) * terrain[r0 + 1, c0] + fx0 * terrain[r0 + 1, c0 + 1])
    )
    if not np.isfinite(base):
        raise ValueError("Elevation is missing (NaN) at coordinate.")

    # Conformal stereographic map distances stretch away from the pole by k = 2 / (1 - sin(lat)).
    # Convert map-grid finite differences to true lunar surface slope via dx_true = dx_map * (1 - sin(lat)) / 2.
    surface_scale = (1.0 - np.sin(lt)) / 2.0
    true_step = 2.0 * pixel_size * surface_scale
    dz_dx = (terrain[r0, c0 + 1] - terrain[r0, c0 - 1]) / true_step
    dz_dy = (terrain[r0 + 1, c0] - terrain[r0 - 1, c0]) / true_step
    slope_deg = float(np.rad2deg(np.arctan(np.hypot(dz_dx, dz_dy))))

    horizons = np.full(360, -90.0, dtype=np.float32)
    distances = np.zeros(360, dtype=np.float32)
    coverage = np.ones(360, dtype=np.uint8)

    for az in range(360):
        bearing = np.deg2rad(az)
        best_angle = -90.0
        best_dist = 0.0
        for d in range(step_m, max_dist_m + 1, step_m):
            a = d / RADIUS
            target_lat = np.arcsin(np.sin(lt) * np.cos(a) + np.cos(lt) * np.sin(a) * np.cos(bearing))
            if np.rad2deg(target_lat) > -80.0:
                coverage[az] = 0
                break
            target_lon = ln + np.arctan2(
                np.sin(bearing) * np.sin(a) * np.cos(lt),
                np.cos(a) - np.sin(lt) * np.sin(target_lat),
            )
            rho = 2.0 * RADIUS * np.tan((np.pi / 2.0 + target_lat) / 2.0)
            col = (rho * np.sin(target_lon) - left) / pixel_size - 0.5
            row = (top - rho * np.cos(target_lon)) / pixel_size - 0.5
            if not (0.0 <= row < height_rows - 1.0 and 0.0 <= col < width_cols - 1.0):
                coverage[az] = 0
                break
            i = int(row)
            j = int(col)
            fy = row - i
            fx = col - j
            h = (
                (1.0 - fy) * ((1.0 - fx) * terrain[i, j] + fx * terrain[i, j + 1])
                + fy * ((1.0 - fx) * terrain[i + 1, j] + fx * terrain[i + 1, j + 1])
            )
            if not np.isfinite(h):
                coverage[az] = 0
                break
            angle = np.rad2deg(np.arctan2((RADIUS + h) * np.cos(a) - RADIUS - base - mast_m, (RADIUS + h) * np.sin(a)))
            if angle > best_angle:
                best_angle = angle
                best_dist = float(d)
        horizons[az] = best_angle
        distances[az] = best_dist

    return float(base), slope_deg, horizons, distances, coverage


class PolarTerrainService:
    """In-memory regional DEM raytracer scoped strictly to the LDEM_80S (-90 to -80 deg) footprint."""

    def __init__(self, tif_path: Path = DEFAULT_TIF, preload: bool = False):
        self.tif_path = Path(tif_path)
        self._terrain: np.ndarray | None = None
        self._left = 0.0
        self._top = 0.0
        self._pixel_size = 80.0
        if preload:
            self._ensure_loaded()

    def _ensure_loaded(self) -> None:
        if self._terrain is not None:
            return
        if not self.tif_path.exists():
            raise FileNotFoundError(f"Missing polar DEM raster: {self.tif_path}")
        with rasterio.open(self.tif_path) as src:
            data = src.read(1).astype(np.float32, copy=False)
            scale = float(src.scales[0]) if src.scales else 1.0
            offset = float(src.offsets[0]) if src.offsets else 0.0
            if scale != 1.0 or offset != 0.0:
                data = data * scale + offset
            self._left = float(src.transform.c)
            self._top = float(src.transform.f)
            self._pixel_size = float(abs(src.transform.a))
            self._terrain = np.ascontiguousarray(data)

    def query(self, lat_deg: float, lon_deg: float, mast_m: float = 5.0, max_dist_m: int = 96000) -> dict:
        if not (-90.0 <= lat_deg <= -80.0):
            raise ValueError(f"Latitude {lat_deg:.4f} is outside supported LDEM_80S coverage (-90 to -80 deg).")
        if mast_m < 0.0 or mast_m > 100.0:
            raise ValueError(f"Invalid mast height {mast_m} m.")

        t0 = perf_counter()
        self._ensure_loaded()
        assert self._terrain is not None

        step_m = int(round(self._pixel_size))
        base96, slope_deg, h96, dist96, cov96 = _march_point(
            self._terrain, self._left, self._top, self._pixel_size, lat_deg, lon_deg, mast_m, max_dist_m, step_m
        )
        _, _, h48, _, cov48 = _march_point(
            self._terrain, self._left, self._top, self._pixel_size, lat_deg, lon_deg, mast_m, min(48000, max_dist_m), step_m
        )
        elapsed_ms = (perf_counter() - t0) * 1000.0
        cov = np.minimum(cov96, cov48)
        covered = int(cov.sum())

        return {
            "lat": float(lat_deg),
            "lon": float(lon_deg),
            "mast_m": float(mast_m),
            "max_dist_m": int(max_dist_m),
            "elevation_m": base96,
            "slope_80m_deg": slope_deg,
            "complete": covered == 360,
            "covered_azimuths": covered,
            "horizon_96km": np.round(h96.astype(float), 4).tolist(),
            "horizon_48km": np.round(h48.astype(float), 4).tolist(),
            "distance_m": np.round(dist96.astype(float), 1).tolist(),
            "coverage": cov.astype(int).tolist(),
            "latency_ms": round(elapsed_ms, 2),
        }


def run_benchmark(tif_path: Path = DEFAULT_TIF) -> dict:
    # Cold call: includes file read, projection setup, and first Numba JIT/execution
    cold_svc = PolarTerrainService(tif_path, preload=False)
    cold_res = cold_svc.query(-89.45, -138.0, mast_m=5.0, max_dist_m=96000)

    # Warm calls across challenging polar sites and extents (48 km, 96 km, 120 km, 144 km)
    probes = [
        ("shackleton_center", -89.45, -138.0),
        ("mons_mouton_center", -84.6378, 31.2588),
        ("malapert_center", -84.906, -4.335),
        ("near_80s_boundary", -80.40, 1.44),
    ]
    warm_latencies_96 = []
    for _ in range(5):
        for _, lat, lon in probes[:3]:
            res = cold_svc.query(lat, lon, mast_m=5.0, max_dist_m=96000)
            warm_latencies_96.append(res["latency_ms"])

    warm_sorted = sorted(warm_latencies_96)
    p50 = float(np.percentile(warm_sorted, 50))
    p95 = float(np.percentile(warm_sorted, 95))

    extent_checks = {}
    for label, lat, lon in probes:
        by_extent = {}
        for dist_km in (48, 96, 120, 144):
            r = cold_svc.query(lat, lon, mast_m=5.0, max_dist_m=dist_km * 1000)
            by_extent[f"{dist_km}km"] = {
                "complete": r["complete"],
                "covered_azimuths": r["covered_azimuths"],
                "max_el_deg": round(max(r["horizon_96km"]), 3),
                "latency_ms": r["latency_ms"],
            }
        extent_checks[label] = by_extent

    return {
        "cold_96km_ms": cold_res["latency_ms"],
        "warm_96km_p50_ms": round(p50, 2),
        "warm_96km_p95_ms": round(p95, 2),
        "extent_checks": extent_checks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--mast", type=float, default=5.0)
    parser.add_argument("--max-dist-m", type=int, default=96000)
    parser.add_argument("--tif", type=Path, default=DEFAULT_TIF)
    parser.add_argument("--benchmark", action="store_true")
    args = parser.parse_args()

    if args.benchmark:
        print(json.dumps(run_benchmark(args.tif), indent=2))
        return
    if args.lat is None or args.lon is None:
        parser.error("Provide --lat and --lon, or pass --benchmark.")
    svc = PolarTerrainService(args.tif, preload=False)
    print(json.dumps(svc.query(args.lat, args.lon, args.mast, args.max_dist_m)))


if __name__ == "__main__":
    main()
