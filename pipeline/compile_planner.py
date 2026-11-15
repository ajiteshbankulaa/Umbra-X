"""Build five-minute planner vectors and optional regional LOLA horizons."""
from contextlib import closing
from datetime import datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
import argparse

import numpy as np
import rasterio
from rasterio.transform import Affine, from_origin
from rasterio.warp import reproject, Resampling
from jplephem.daf import DAF
from jplephem.pck import PCK
from numba import njit, prange
from pyproj import Transformer
from skyfield.api import PlanetaryConstants, load, load_file
from skyfield.framelib import itrs

from fetch_nasa_data import CACHE, POLAR_SITES, KERNELS
from umbra_x.compiler import CRS_POLAR, MASTS, RADIUS, compile_horizons_with_distance

REGIONAL = "https://pgda.gsfc.nasa.gov/data/LOLA_80mpp/LDEM_80S_80MPP_ADJ.TIF"
FRAME = "MOON_ME_DE440_ME421"
STATION = [-2353621.365667699, -4641341.49114994, 3677052.329319744]


def vectors(kernels, start, count, step_minutes=5):
    constants = PlanetaryConstants()
    for name in ("moon_de440_250416.tf", "pck00011.tpc"):
        with (kernels / name).open("rb") as stream:
            constants.read_text(stream)
    times = load.timescale().from_datetimes([start + timedelta(minutes=step_minutes*i) for i in range(count)])
    output = np.empty((count, 12))
    remaining = np.ones(count, dtype=bool)
    with (kernels / "moon_pa_de440_200625.bpc").open("rb") as stream, closing(
        load_file(str(kernels / "de440s.bsp"))
    ) as planets:
        frame_id = constants.variables[f"FRAME_{FRAME}"]
        relative = constants.variables[f"TKFRAME_{frame_id}_RELATIVE"]
        for segment in reversed(PCK(DAF(stream)).segments):
            if segment.body != constants.variables[f"FRAME_{relative}"]:
                continue
            mask = remaining & (segment.initial_jd <= times.tdb) & (times.tdb <= segment.final_jd)
            if not mask.any():
                continue
            t = times[mask]
            frame = constants.build_frame(frame_id, _segment=segment)
            moon = planets["moon"].at(t)
            earth_app = None
            for offset, name in ((0, "sun"), (3, "earth")):
                # Apparent Moon-centered positions (light-time + stellar aberration) matching JPL Horizons AIRLESS.
                apparent_xyz = moon.observe(planets[name]).apparent().frame_xyz(frame).m.T
                output[mask, offset:offset+3] = apparent_xyz
                if name == "earth":
                    earth_app = apparent_xyz
            rotation = np.einsum("ijn,kjn->ikn", frame.rotation_at(t), itrs.rotation_at(t))
            station = np.einsum("ijn,j->in", rotation, STATION)
            axis = np.array(STATION) / np.array([6378137.0, 6378137.0, 6356752.314245])**2
            up = np.einsum("ijn,j->in", rotation, axis / np.linalg.norm(axis))
            output[mask, 6:9] = earth_app + station.T
            output[mask, 9:12] = up.T
            remaining[mask] = False
    if remaining.any():
        raise ValueError("Lunar orientation does not cover planner dates")
    return output


def calibrated_horizon_uncertainty(distance, local_distance, local_mast_sigma, observer_sigma, regional_error_m=2.5):
    """Calibrate per-pad horizon uncertainty from local vs regional occluder distance."""
    regional_controls = distance > local_distance
    safe_distance = np.maximum(distance, 1.0)
    combined_vertical_err = np.hypot(observer_sigma[:, None, None], regional_error_m)
    regional_sigma = np.rad2deg(np.arctan2(combined_vertical_err, safe_distance))
    per_mast = np.where(regional_controls, regional_sigma, local_mast_sigma)
    return per_mast.max(axis=1).astype("<f4")


def extend(local, terrain, observers, transform, stop, local_bounds, local_distance=None):
    """Extend local horizons across regional terrain while preserving local occluder distances."""
    distance = (
        np.zeros(local.shape, dtype=np.float32)
        if local_distance is None
        else np.array(local_distance, dtype=np.float32, copy=True)
    )
    return _extend_kernel(local, terrain, observers, transform, stop, local_bounds, distance)


@njit(cache=True, parallel=True)
def _extend_kernel(local, terrain, observers, transform, stop, local_bounds, distance):
    result = local.copy()
    complete = np.ones((local.shape[0], 360), dtype=np.uint8)
    left, top = transform
    west, south, east, north = local_bounds
    for node in prange(local.shape[0]):
        lat, lon, base = observers[node]
        lt, ln = np.deg2rad(lat), np.deg2rad(lon)
        for az in range(360):
            bearing = np.deg2rad(az)
            for d in range(40, stop + 1, 80):
                a = d / RADIUS
                target_lat = np.arcsin(np.sin(lt)*np.cos(a) + np.cos(lt)*np.sin(a)*np.cos(bearing))
                target_lon = ln + np.arctan2(np.sin(bearing)*np.sin(a)*np.cos(lt),
                                             np.cos(a)-np.sin(lt)*np.sin(target_lat))
                rho = 2*RADIUS*np.tan((np.pi/2 + target_lat)/2)
                x, y = rho*np.sin(target_lon), rho*np.cos(target_lon)
                # At short range use fine terrain until 160 m before its edge.
                # Farther out retain the existing coarse samples and grid phase.
                if d < 1800 and west+160 <= x <= east-160 and south+160 <= y <= north-160:
                    continue
                col = (x-left)/80 - .5
                row = (top-y)/80 - .5
                if not (0 <= row < terrain.shape[0]-1 and 0 <= col < terrain.shape[1]-1):
                    complete[node, az] = 0
                    break
                i, j = int(row), int(col)
                fy, fx = row-i, col-j
                height = ((1-fy)*((1-fx)*terrain[i,j]+fx*terrain[i,j+1])
                          +fy*((1-fx)*terrain[i+1,j]+fx*terrain[i+1,j+1]))
                if not np.isfinite(height):
                    complete[node, az] = 0
                    continue
                for m in range(len(MASTS)):
                    angle = np.rad2deg(np.arctan2((RADIUS+height)*np.cos(a)-RADIUS-base-MASTS[m],
                                                 (RADIUS+height)*np.sin(a)))
                    if angle > result[node,m,az]:
                        result[node,m,az] = angle
                        distance[node,m,az] = d
    return result, distance, complete


def regional_raster(transform, cache_path, extent):
    x, y = transform * (128, 128)
    size = (extent * 2 + 6400) // 80
    grid = from_origin(x-size*40, y+size*40, 80, 80)
    if cache_path.exists():
        return np.load(cache_path), grid
    data = np.full((size, size), np.nan, dtype=np.float32)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="25"):
        local_source = CACHE / "LDEM_80S_80MPP_ADJ.TIF"
        with rasterio.open(local_source if local_source.exists() else REGIONAL) as src:
            reproject(rasterio.band(src, 1), data, dst_transform=grid, dst_crs=CRS_POLAR,
                      dst_nodata=np.nan, resampling=Resampling.bilinear)
            data = data * src.scales[0] + src.offsets[0]
    np.save(cache_path, data)
    return data, grid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-only", action="store_true")
    parser.add_argument("--output", type=Path, default=CACHE.parent.parent / "web/public/data/planner-release")
    args = parser.parse_args()
    start = datetime.fromisoformat(json.loads((CACHE / "apollo_11_ephemeris.json").read_text())["start_utc"])
    count = 720 * 12 + 1
    kernels = CACHE / "kernels"
    state = vectors(kernels, start, count)
    shared = args.output / "planner"
    shared.mkdir(parents=True, exist_ok=True)
    raw = state.astype("<f8").tobytes()
    digest = sha256(raw).hexdigest()
    (shared / f"{digest}.bin").write_bytes(raw)
    inverse = Transformer.from_crs(CRS_POLAR, CRS_POLAR.geodetic_crs, always_xy=True)
    for site in POLAR_SITES:
        folder = args.output / site.id.replace("_", "-")
        manifest = json.loads((folder / "manifest.json").read_text())
        grid = manifest["analysis_grid"]
        with np.load(CACHE / f"{site.id}_terrain.npz") as terrain_npz:
            transform = Affine(*terrain_npz["transform"][:6])
            pixels = grid["start_pixel"] + grid["step_pixel"] * np.arange(31)
            cols, rows = np.meshgrid(pixels, pixels)
            x, y = transform * (cols+.5, rows+.5)
            lon, lat = inverse.transform(x, y)
            dem_elev = terrain_npz["dem_elev"]
            dem_err = terrain_npz["dem_err"]
            observers = np.stack((lat, lon, dem_elev[rows, cols]), axis=-1).reshape(-1, 3)
            observer_sigma = dem_err[rows, cols].reshape(-1)
            slope_benchmark = None
            if "dem_slope" in terrain_npz and "lola_slope" in terrain_npz:
                dem_obs_slope = terrain_npz["dem_slope"][rows, cols].reshape(-1)
                lola_obs_slope = terrain_npz["lola_slope"][rows, cols].reshape(-1)
                abs_diff = np.abs(dem_obs_slope - lola_obs_slope)
                finite = np.isfinite(abs_diff)
                if finite.any():
                    center_idx = 480 if len(dem_obs_slope) > 480 else len(dem_obs_slope) // 2
                    slope_benchmark = {
                        "sampleCount": int(finite.sum()),
                        "medianAbsDiffDeg": round(float(np.median(abs_diff[finite])), 4),
                        "p95AbsDiffDeg": round(float(np.percentile(abs_diff[finite], 95)), 4),
                        "maxAbsDiffDeg": round(float(np.max(abs_diff[finite])), 4),
                        "pad481DemDeg": round(float(dem_obs_slope[center_idx]), 4),
                        "pad481LolaDeg": round(float(lola_obs_slope[center_idx]), 4),
                    }
        local_bytes = (folder / "horizons.bin").read_bytes()
        local = np.frombuffer(local_bytes, dtype="<f4").reshape(-1,5,360)
        info = {"schema": 1, "start": start.isoformat(), "stepMinutes": 5, "count": count,
                "ephemerisModel": "DE440 apparent (LT+S)",
                "vectorHash": digest, "localHash": sha256(local_bytes).hexdigest(), "frame": FRAME,
                "station": {"name": "Goldstone DSS-14", "maskDeg": 10, "itrfMeters": STATION,
                            "source": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/FORTRAN/spicelib/spkcpt.html"},
                "kernels": {name: {"url": url, "sha256": sha256((kernels/name).read_bytes()).hexdigest()}
                            for name, url in KERNELS.items()},
                "slopeBenchmark": slope_benchmark,
                "observers": observers.tolist(), "regional": None}
        if not args.local_only:
            extent = 96000
            _, _, local_distance, local_mast_sigma = compile_horizons_with_distance(dem_elev, dem_err, transform, grid)
            local_distance = local_distance.reshape(-1, len(MASTS), 360)
            local_mast_sigma = local_mast_sigma.reshape(-1, len(MASTS), 360)
            terrain, affine = regional_raster(transform, CACHE / f"{site.id}_regional_{extent}.npy", extent)
            west, north = transform * (.5, .5)
            east, south = transform * (255.5, 255.5)
            bounds = (west, south, east, north)
            middle, _, _ = extend(local, terrain, observers, (affine.c, affine.f), 48000, bounds, local_distance)
            result, distance, coverage = extend(local, terrain, observers, (affine.c, affine.f), extent, bounds, local_distance)
            horizon_err = calibrated_horizon_uncertainty(distance, local_distance, local_mast_sigma, observer_sigma)
            (folder / "horizons_err.bin").write_bytes(horizon_err.tobytes())
            paths = {}
            for key, values in (("regional",result), ("distance",distance), ("coverage",coverage),
                                ("sensitivity",middle)):
                payload = values.astype("u1" if key == "coverage" else "<f4").tobytes()
                checksum = sha256(payload).hexdigest()
                (shared / f"{checksum}.bin").write_bytes(payload)
                paths[key] = checksum
            info["regional"] = {"radiusM": extent, "comparisonRadiusM": 48000, "source": REGIONAL,
                                "localOverlapM": 160,
                                **paths}
        (folder / "planner.json").write_text(json.dumps(info, allow_nan=False), encoding="utf-8")
        print(f"{site.id}: planner vectors and {'local' if args.local_only else 'regional'} geometry", flush=True)


if __name__ == "__main__":
    main()
