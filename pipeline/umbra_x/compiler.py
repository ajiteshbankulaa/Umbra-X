"""Compile co-registered LOLA rasters and JPL ephemerides to the static contract."""

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory

from numba import njit, prange
import numpy as np
from pyproj import CRS, Transformer
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling
from skyfield.api import load, load_file, PlanetaryConstants


RADIUS = 1_737_400
PROJECTION = "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"
CRS_POLAR = CRS.from_proj4(PROJECTION)
WIDTH = 256
PIXEL = 20.0
ROWS = 31
START_PIXEL = 23
STEP_PIXEL = 7
CANDIDATES = slice(START_PIXEL, START_PIXEL + STEP_PIXEL * ROWS, STEP_PIXEL)
ANALYSIS_GRID = {
    "rows": ROWS, "cols": ROWS, "spacing_m": PIXEL * STEP_PIXEL,
    "start_pixel": START_PIXEL, "step_pixel": STEP_PIXEL,
}
MASTS = np.array([1.5, 3.0, 5.0, 10.0, 20.0])
CITATIONS = [
    "Barker, Mazarico et al. (2023) PSJ — LRO LOLA DEM & Error",
    "Gläser et al. (2018) PSS — Two-Site Shadow Complementarity",
    "Paige et al. (2010) Science & NASA ShadowCam (2025) — PSR Radiosity & Cold Traps",
    "Zimmerman, Farrell et al. (NASA GSFC) — Terminator Plasma Wake & Electrostatic Dust Lofting",
    "Hernandez et al. (2025) NASA Langley OPAL/Light Bender & Astrobotic LunaGrid",
]


def read_tile(path, transform):
    destination = np.full((WIDTH, WIDTH), np.nan)
    with rasterio.open(path) as source:
        reproject(
            source=rasterio.band(source, 1),
            destination=destination,
            dst_transform=transform,
            dst_crs=CRS_POLAR.to_wkt(),
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        destination *= source.scales[0]
        destination += source.offsets[0]
    if not np.isfinite(destination).all():
        raise ValueError(f"Incomplete raster coverage: {path}")
    return destination


def read_psr_mask(path, transform):
    labels = np.full((WIDTH, WIDTH), np.nan)
    with rasterio.open(path) as source:
        reproject(
            rasterio.band(source, 1), labels, dst_transform=transform,
            dst_crs=CRS_POLAR.to_wkt(), dst_nodata=np.nan, resampling=Resampling.nearest,
        )
    if not np.isin(labels, (0, 1)).all():
        raise ValueError(f"Missing or invalid values in PSR raster: {path}")
    return labels.astype(np.uint8)


@njit(cache=True, parallel=True)
def march(elevation, error, longitude, ground_pixel):
    horizons = np.empty((ROWS, ROWS, len(MASTS), 360), dtype=np.float32)
    uncertainty = np.empty((ROWS, ROWS, 360), dtype=np.float32)
    half_pixel = PIXEL / 2
    for node in prange(ROWS * ROWS):
        row, col = node // ROWS, node % ROWS
        y = START_PIXEL + STEP_PIXEL * row
        x = START_PIXEL + STEP_PIXEL * col
        base = elevation[y, x]
        for az in range(360):
            # A true-north ray in south-polar stereographic grid coordinates.
            angle = np.deg2rad(az) + longitude[row, col]
            dx, dy = np.sin(angle) / 2, -np.cos(angle) / 2
            maxima = np.full(len(MASTS), -np.inf)
            sigma = np.zeros(len(MASTS))
            step = 2
            while True:
                i, j = y + step * dy, x + step * dx
                if i < 0 or j < 0 or i >= WIDTH - 1 or j >= WIDTH - 1:
                    break
                i0, j0 = int(i), int(j)
                fy, fx = i - i0, j - j0
                weights = ((1-fy)*(1-fx), (1-fy)*fx, fy*(1-fx), fy*fx)
                distance = step * half_pixel * ground_pixel[row, col] / PIXEL
                height = -base - distance**2 / (2 * RADIUS)
                # Correlated interpolation within the target sample.
                target_sigma = 0.0
                for corner in range(4):
                    ri, cj = i0 + corner // 2, j0 + corner % 2
                    height += weights[corner] * elevation[ri, cj]
                    target_sigma += weights[corner] * error[ri, cj]
                height_sigma = np.hypot(target_sigma, error[y, x])
                for mast in range(len(MASTS)):
                    rise = height - MASTS[mast]
                    tangent = rise / distance
                    if tangent > maxima[mast]:
                        maxima[mast] = tangent
                        sigma[mast] = np.rad2deg(height_sigma / distance / (1 + tangent**2))
                step += 1
            for mast in range(len(MASTS)):
                horizons[row, col, mast, az] = np.rad2deg(np.arctan(maxima[mast]))
            uncertainty[row, col, az] = sigma.max()
    return horizons, uncertainty


def ephemeris(start, lat, lon, kernels):
    constants = PlanetaryConstants()
    for name in ("moon_080317.tf", "pck00008.tpc"):
        with (kernels / name).open("rb") as stream:
            constants.read_text(stream)
    dates = [start + timedelta(hours=hour) for hour in range(720)]
    times = load.timescale().from_datetimes(dates)
    with (kernels / "moon_pa_de421_1900-2050.bpc").open("rb") as orientation, closing(
        load_file(str(kernels / "de421.bsp"))
    ) as planets:
        constants.read_binary(orientation)
        frame = constants.build_frame_named("MOON_ME_DE421")
        observer = planets["moon"] + constants.build_latlon_degrees(frame, lat, lon)
        at = observer.at(times)
        result = {
            "start_utc": start.isoformat().replace("+00:00", "Z"),
            "step_hours": 1,
            "num_steps": len(dates),
            "timestamps": [date.isoformat().replace("+00:00", "Z") for date in dates],
        }
        for body in ("sun", "earth"):
            altitude, azimuth, _ = at.observe(planets[body]).apparent().altaz()
            result[f"{body}_az_deg"] = azimuth.degrees.tolist()
            result[f"{body}_el_deg"] = altitude.degrees.tolist()
    return result


def compile_horizons(elevation, error, transform):
    inverse = Transformer.from_crs(CRS_POLAR, CRS_POLAR.geodetic_crs, always_xy=True)
    pixels = np.arange(WIDTH)[CANDIDATES] + 0.5
    x, y = transform * tuple(np.meshgrid(pixels, pixels))
    longitude, latitude = inverse.transform(x, y)
    ground_pixel = PIXEL * (1 - np.sin(np.deg2rad(latitude))) / 2
    return march(elevation, error, np.deg2rad(longitude), ground_pixel)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--subtitle", default="Lunar south pole")
    parser.add_argument("--agency", required=True)
    parser.add_argument("--clps", action="append", default=[])
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--moon-trek-url", default="https://trek.nasa.gov/moon/")
    parser.add_argument("--start-utc", required=True)
    for key in ("dem", "error", "psr", "kernels", "output"):
        parser.add_argument(f"--{key}", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.site_id):
        parser.error("site-id must be a lowercase slug")
    if not -90 <= args.lat < -60 or not -180 <= args.lon <= 180:
        parser.error("expected south-polar latitude [-90, -60) and longitude [-180, 180]")
    try:
        start = datetime.fromisoformat(args.start_utc)
        if start.utcoffset() != timedelta(0):
            raise ValueError
        start = start.astimezone(timezone.utc)
    except ValueError:
        parser.error("start-utc must be an ISO 8601 UTC timestamp")

    destination = args.output / args.site_id
    if destination.exists():
        parser.error(f"Output already exists: {destination}")
    forward = Transformer.from_crs(CRS_POLAR.geodetic_crs, CRS_POLAR, always_xy=True)
    inverse = Transformer.from_crs(CRS_POLAR, CRS_POLAR.geodetic_crs, always_xy=True)
    x, y = forward.transform(args.lon, args.lat)
    left, top = x - WIDTH * PIXEL / 2, y + WIDTH * PIXEL / 2
    transform = from_origin(left, top, PIXEL, PIXEL)
    elev, err = (read_tile(path, transform) for path in (args.dem, args.error))
    mask = read_psr_mask(args.psr, transform)
    if (err < 0).any():
        parser.error("Height uncertainty must be nonnegative")
    coordinates = (np.arange(WIDTH) + 0.5) * PIXEL
    _, lat = inverse.transform(*np.meshgrid(left + coordinates, top - coordinates))
    scale_corrected_pixel = PIXEL * (1 - np.sin(np.deg2rad(lat))) / 2
    dy, dx = np.gradient(elev)
    slope = np.rad2deg(np.arctan(np.hypot(dx, dy) / scale_corrected_pixel))
    manifest = {
        "site_id": args.site_id, "name": args.name, "subtitle": args.subtitle,
        "mission_agency": args.agency,
        "nssdca_reference": {
            "apollo_baseline": {
                "name": "Apollo 11 (Mare Tranquillitatis)", "lat": 0.674,
                "lon": 23.473, "earth_el_deg": 66.2,
            },
            "clps_missions": args.clps,
        },
        "citations": CITATIONS, "center_lat": args.lat, "center_lon": args.lon,
        "moon_trek_url": args.moon_trek_url, "proj_crs": PROJECTION,
        "dem_grid": {"width": WIDTH, "height": WIDTH, "pixel_size_m": PIXEL},
        "analysis_grid": ANALYSIS_GRID,
        "mast_heights_m": MASTS.tolist(),
        "ephemeris": ephemeris(start, args.lat, args.lon, args.kernels),
    }
    horizons, horizons_err = compile_horizons(elev, err, transform)
    args.output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.output) as staging:
        tile = Path(staging) / args.site_id
        tile.mkdir()
        for name, data in (
            ("dem_elev", elev), ("dem_slope", slope), ("dem_err", err),
            ("horizons", horizons), ("horizons_err", horizons_err),
        ):
            data.astype("<f4").tofile(tile / f"{name}.bin")
        mask.tofile(tile / "psr_mask.bin")
        (tile / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        tile.rename(destination)


if __name__ == "__main__":
    main()
