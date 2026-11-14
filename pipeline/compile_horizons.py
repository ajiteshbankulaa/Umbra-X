"""Compile browser bundles from the cached NASA terrain and Horizons data."""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from rasterio.transform import Affine

from fetch_nasa_data import APOLLO, CACHE, POLAR_SITES
from umbra_x.compiler import ANALYSIS_GRID, CITATIONS, COMPACT_GRID, MASTS, PIXEL, PROJECTION, WIDTH, compile_horizons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=CACHE)
    parser.add_argument("--output", type=Path, default=CACHE.parent.parent / "web" / "public" / "data")
    parser.add_argument("--grid", choices=("compact", "expanded"), default="compact")
    args = parser.parse_args()
    grid = COMPACT_GRID if args.grid == "compact" else ANALYSIS_GRID
    args.output.mkdir(parents=True, exist_ok=True)
    for site in POLAR_SITES:
        site_id = site.id.replace("_", "-")
        ephem = json.loads((args.cache / f"{site.id}_ephemeris.json").read_text(encoding="utf-8"))
        with np.load(args.cache / f"{site.id}_terrain.npz") as terrain:
            arrays = {key: terrain[key] for key in ("dem_elev", "dem_slope", "dem_err")}
            mask = terrain["psr"]
            transform = Affine(*terrain["transform"][:6])
        if mask.shape != (WIDTH, WIDTH) or not np.isin(mask, (0, 1)).all():
            raise ValueError(f"{site_id}: invalid cached PSR mask")
        arrays["horizons"], arrays["horizons_err"] = compile_horizons(
            arrays["dem_elev"], arrays["dem_err"], transform, grid,
        )
        manifest = {
            "site_id": site_id, "name": site.name, "subtitle": "Lunar south pole", "mission_agency": "NASA",
            "nssdca_reference": {
                "apollo_baseline": {"name": APOLLO.name, "lat": APOLLO.lat, "lon": APOLLO.lon, "earth_el_deg": 66.2},
                "clps_missions": {
                    "mons_mouton": ["IM-2 Athena"],
                    "malapert_massif": ["IM-1 Odysseus (Malapert A region)"],
                }.get(site.id, []),
            },
            "citations": CITATIONS, "center_lat": site.lat, "center_lon": (site.lon + 180) % 360 - 180,
            "moon_trek_url": "https://trek.nasa.gov/moon/", "proj_crs": PROJECTION,
            "dem_grid": {"width": WIDTH, "height": WIDTH, "pixel_size_m": PIXEL},
            "analysis_grid": grid, "mast_heights_m": MASTS.tolist(), "ephemeris": ephem,
        }
        destination = args.output / site_id
        with TemporaryDirectory(dir=args.output) as staging:
            temporary = Path(staging)
            for name, values in arrays.items():
                values.astype("<f4").tofile(temporary / f"{name}.bin")
            mask.astype(np.uint8).tofile(temporary / "psr_mask.bin")
            (temporary / "manifest.json").write_text(
                json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8",
            )
            destination.mkdir(exist_ok=True)
            for filename in [*(f"{name}.bin" for name in arrays), "psr_mask.bin", "manifest.json"]:
                (temporary / filename).replace(destination / filename)
        print(f"Compiled {site_id}", flush=True)
    apollo = args.cache / "apollo_11_ephemeris.json"
    if apollo.exists():
        temporary = args.output / "apollo-11.tmp"
        temporary.write_bytes(apollo.read_bytes())
        temporary.replace(args.output / "apollo-11.json")


if __name__ == "__main__":
    main()
