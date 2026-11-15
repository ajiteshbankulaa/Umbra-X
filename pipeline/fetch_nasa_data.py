"""Cache NASA terrain windows and topocentric ephemerides for Umbra-X."""

import argparse
from contextlib import closing
import csv
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from jplephem.daf import DAF
from jplephem.pck import PCK
import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.transform import from_origin
import requests
from requests.adapters import HTTPAdapter
from skyfield.api import PlanetaryConstants, load, load_file
from urllib3.util.retry import Retry

from umbra_x.compiler import ANALYSIS_GRID, CANDIDATES, CRS_POLAR, PIXEL, ROWS, START_PIXEL, STEP_PIXEL, WIDTH, read_psr_mask, read_tile

CACHE = Path(__file__).resolve().parent / "cache"
DEFAULT_START = "2026-11-14T00:00:00Z"
STEPS = 720
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
PGDA = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/"
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
RASTERS = {
    "dem_elev": PGDA + "LDEM_80S_20MPP_ADJ.TIF",
    "dem_err": PGDA + "LDEM_80S_20MPP_ADJ_ERR.TIF",
    "lola_slope": PGDA + "LDSM_80S_20MPP_ADJ.TIF",
    "psr": PGDA + "LPSR_80S_20MPP_ADJ.TIF",
}
KERNELS = {
    "de440s.bsp": NAIF + "spk/planets/de440s.bsp",
    "moon_de440_250416.tf": NAIF + "fk/satellites/moon_de440_250416.tf",
    "moon_pa_de440_200625.bpc": NAIF + "pck/moon_pa_de440_200625.bpc",
    "pck00011.tpc": NAIF + "pck/pck00011.tpc",
}
BODIES = {"sun": 10, "earth": 399}


@dataclass(frozen=True)
class Site:
    id: str
    name: str
    lat: float
    lon: float


POLAR_SITES = (
    Site("shackleton_ridge", "Shackleton Rim & PSR Edge", -89.450, 222.000),
    Site("mons_mouton", "Mons Mouton Plateau", -84.790, 29.200),
    Site("malapert_massif", "Malapert Peak & Crater Shadow", -86.040, 2.700),
)
APOLLO = Site("apollo_11", "Apollo 11 (Mare Tranquillitatis)", 0.674, 23.473)


def nasa_session():
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=Retry(
        total=3, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504),
    )))
    return session


def dates_from(start):
    return [start + timedelta(hours=i) for i in range(STEPS)]


def iso(date):
    return date.isoformat().replace("+00:00", "Z")


def parse_horizons(result, dates):
    _, marker, rest = result.partition("$$SOE")
    table, end, _ = rest.partition("$$EOE")
    if not marker or not end:
        raise ValueError("Horizons returned no observer table")
    rows = list(csv.reader(table.strip().splitlines()))
    if len(rows) != len(dates):
        raise ValueError(f"Horizons returned {len(rows)} rows, expected {len(dates)}")
    angles = []
    for row, expected in zip(rows, dates, strict=True):
        if len(row) < 5 or row[0].strip() != expected.strftime("%Y-%b-%d %H:%M"):
            raise ValueError(f"Unexpected Horizons row at {iso(expected)}: {row}")
        angles.append((float(row[3]), float(row[4])))
    az, el = np.asarray(angles).T
    if not ((0 <= az) & (az < 360) & (-90 <= el) & (el <= 90)).all():
        raise ValueError("Horizons returned invalid azimuth or elevation")
    return az.tolist(), el.tolist()


def fetch_ephemeris(session, cache, site, start):
    dates = dates_from(start)
    ephemeris = {
        "start_utc": iso(start), "step_hours": 1, "num_steps": STEPS,
        "timestamps": [iso(date) for date in dates],
    }
    raw_dir = cache / "horizons" / start.strftime("%Y%m%dT%H%MZ") / site.id
    raw_dir.mkdir(parents=True, exist_ok=True)
    for body, target in BODIES.items():
        path = raw_dir / f"{body}.json"
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
        else:
            params = {
                "COMMAND": str(target), "CENTER": "coord@301", "COORD_TYPE": "GEODETIC",
                "SITE_COORD": f"{site.lon},{site.lat},0", "EPHEM_TYPE": "OBSERVER",
                "QUANTITIES": "4", "STEP_SIZE": "1 h", "CSV_FORMAT": "YES",
                "EXTRA_PREC": "YES", "APPARENT": "AIRLESS",
                "START_TIME": dates[0].strftime("%Y-%m-%d %H:%M"),
                "STOP_TIME": dates[-1].strftime("%Y-%m-%d %H:%M"),
            }
            response = session.get(
                HORIZONS, params={"format": "json", **{key: f"'{value}'" for key, value in params.items()}},
                timeout=45,
            )
            response.raise_for_status()
            payload = response.json()
            if "error" in payload:
                raise RuntimeError(f"Horizons ({site.id}, {body}): {payload['error']}")
        az, el = parse_horizons(payload["result"], dates)
        if not path.exists():
            save_json(path, payload)
        ephemeris[f"{body}_az_deg"], ephemeris[f"{body}_el_deg"] = az, el
    return ephemeris


def save_json(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def download_kernels(session, cache):
    directory = cache / "kernels"
    directory.mkdir(parents=True, exist_ok=True)
    for name, url in KERNELS.items():
        path = directory / name
        if path.exists() and path.stat().st_size:
            continue
        temporary = path.with_suffix(".part")
        with session.get(url, stream=True, timeout=45) as response:
            response.raise_for_status()
            with temporary.open("wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    output.write(chunk)
        temporary.replace(path)


def skyfield_angles(kernels, site, dates):
    constants = PlanetaryConstants()
    for filename in ("moon_de440_250416.tf", "pck00011.tpc"):
        with (kernels / filename).open("rb") as stream:
            constants.read_text(stream)
    times = load.timescale().from_datetimes(dates)
    with (kernels / "moon_pa_de440_200625.bpc").open("rb") as orientation, closing(
        load_file(str(kernels / "de440s.bsp"))
    ) as planets:
        # Skyfield's default frame builder retains only the last segment for each
        # frame. The DE440 PCK has several consecutive segments for lunar PA.
        frame_name = "MOON_ME_DE440_ME421"
        frame_id = constants.variables[f"FRAME_{frame_name}"]
        relative = constants.variables[f"TKFRAME_{frame_id}_RELATIVE"]
        relative_id = constants.variables[f"FRAME_{relative}"]
        angles = {body: (np.empty(len(dates)), np.empty(len(dates))) for body in BODIES}
        remaining = np.ones(len(dates), dtype=bool)
        for segment in reversed(PCK(DAF(orientation)).segments):
            if segment.body != relative_id:
                continue
            covered = remaining & (times.tdb >= segment.initial_jd) & (times.tdb <= segment.final_jd)
            if not covered.any():
                continue
            frame = constants.build_frame(frame_id, _segment=segment)
            observer = planets["moon"] + constants.build_latlon_degrees(frame, site.lat, site.lon)
            at = observer.at(times[covered])
            for body, (azimuth, elevation) in angles.items():
                el, az, _ = at.observe(planets[body]).apparent().altaz()
                azimuth[covered], elevation[covered] = az.degrees, el.degrees
            remaining[covered] = False
        if remaining.any():
            raise ValueError("The lunar orientation kernel does not cover every requested epoch")
        return angles


def compute_geodetic_slope(elev, transform):
    """Compute true lunar surface slope (deg) from stereographic DEM array and affine transform."""
    rows, cols = elev.shape
    pixel_x = float(transform.a)
    pixel_y = float(-transform.e)
    xs = transform.c + (np.arange(cols) + 0.5) * pixel_x
    ys = transform.f - (np.arange(rows) + 0.5) * pixel_y
    xg, yg = np.meshgrid(xs, ys)
    inv_proj = Transformer.from_crs(CRS_POLAR, CRS_POLAR.geodetic_crs, always_xy=True)
    _, lat_grid = inv_proj.transform(xg, yg)
    # Conformal stereographic scale correction matching umbra_x/compiler.py: dx_true = dx_map * (1 - sin(lat)) / 2.
    surface_scale = (1.0 - np.sin(np.deg2rad(lat_grid))) / 2.0
    dy_map, dx_map = np.gradient(elev, pixel_y, pixel_x)
    return np.rad2deg(np.arctan(np.hypot(dx_map / surface_scale, dy_map / surface_scale)))


def terrain_window(site, sources):
    project = Transformer.from_crs(CRS_POLAR.geodetic_crs, CRS_POLAR, always_xy=True)
    x, y = project.transform(site.lon, site.lat)
    transform = from_origin(x - WIDTH * PIXEL / 2, y + WIDTH * PIXEL / 2, PIXEL, PIXEL)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="30"):
        arrays = {
            key: read_tile(sources[key], transform)
            for key in ("dem_elev", "dem_err", "lola_slope")
        }
        arrays["psr"] = read_psr_mask(sources["psr"], transform)
    if (arrays["dem_err"] < 0).any():
        raise ValueError(f"{site.id}: negative NASA height uncertainty")
    arrays["dem_slope"] = compute_geodetic_slope(arrays["dem_elev"], transform)
    return arrays, transform


def plot_terrain(cache, terrain):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle

    figure, axes = plt.subplots(len(terrain), 3, figsize=(12, 11), layout="constrained")
    for (site, data), row in zip(terrain, axes, strict=True):
        for axis, key, title, cmap in zip(
            row, ("dem_elev", "dem_slope", "psr"),
            ("Elevation (m)", "Gradient slope (°)", "Mapped PSR"), ("terrain", "magma", "Greys"), strict=True,
        ):
            limits = {"vmin": 0, "vmax": 1} if key == "psr" else {}
            image = axis.imshow(data[key], cmap=cmap, **limits)
            end = START_PIXEL + (ROWS - 1) * STEP_PIXEL
            axis.add_patch(Rectangle((START_PIXEL, START_PIXEL), end - START_PIXEL, end - START_PIXEL,
                                     fill=False, edgecolor="#00bcd4", linewidth=1))
            axis.set_title(f"{site.name}\n{title}", fontsize=10)
            axis.set_axis_off()
            if key != "psr":
                figure.colorbar(image, ax=axis, shrink=0.75)
    figure.suptitle("Umbra-X · NASA LOLA terrain verification\n5.12 km tiles · cyan outlines the candidate grid")
    figure.savefig(cache / "verify_dem_and_slope.png", dpi=160)
    plt.close(figure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-utc", default=DEFAULT_START)
    parser.add_argument("--cache", type=Path, default=CACHE)
    parser.add_argument("--raster-dir", type=Path, help="Read the four official GeoTIFFs from this local directory")
    parser.add_argument("--refresh-terrain", action="store_true", help="Fetch terrain even when local windows exist")
    args = parser.parse_args()
    try:
        start = datetime.fromisoformat(args.start_utc)
        if start.utcoffset() != timedelta(0) or start.second or start.microsecond:
            raise ValueError
        start = start.astimezone(timezone.utc)
    except ValueError:
        parser.error("--start-utc must be an ISO UTC timestamp at minute precision")
    cache = args.cache
    cache.mkdir(parents=True, exist_ok=True)
    with nasa_session() as session:
        download_kernels(session, cache)
        for site in (*POLAR_SITES, APOLLO):
            data = fetch_ephemeris(session, cache, site, start)
            save_json(cache / f"{site.id}_ephemeris.json", data)
            print(f"{site.id}: cached {STEPS} hours for Sun and Earth", flush=True)

    sources = {
        key: str(args.raster_dir / url.rsplit("/", 1)[-1]) if args.raster_dir else f"/vsicurl/{url}"
        for key, url in RASTERS.items()
    }
    terrain = []
    coverage = {}
    for site in POLAR_SITES:
        path = cache / f"{site.id}_terrain.npz"
        if path.exists() and not (args.refresh_terrain or args.raster_dir):
            with np.load(path) as stored:
                data = {key: stored[key] for key in (*RASTERS, "dem_slope")}
        else:
            data, transform = terrain_window(site, sources)
            temporary = path.with_suffix(".part.npz")
            np.savez_compressed(temporary, **data, transform=tuple(transform))
            temporary.replace(path)
        mask = data["psr"]
        node_count = int(mask[CANDIDATES, CANDIDATES].sum())
        end = START_PIXEL + (ROWS - 1) * STEP_PIXEL
        coverage[site.id] = {
            "tile_psr_pixels": int(data["psr"].sum()),
            "psr_pixels_inside_grid": int(mask[START_PIXEL:end + 1, START_PIXEL:end + 1].sum()),
            "candidate_psr_nodes": node_count,
            "candidate_non_psr_nodes": ROWS * ROWS - node_count,
        }
        terrain.append((site, data))
        print(f"{site.id}: {node_count}/{ROWS * ROWS} candidates in mapped PSRs", flush=True)
    plot_terrain(cache, terrain)
    save_json(cache / "provenance.json", {
        "start_utc": iso(start), "horizons": HORIZONS, "rasters": RASTERS, "kernels": KERNELS,
        "apollo_coordinates": "https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html",
        "sites": [vars(site) for site in (*POLAR_SITES, APOLLO)],
        "psr_coverage": coverage,
        "analysis_grid": ANALYSIS_GRID,
    })


if __name__ == "__main__":
    main()
