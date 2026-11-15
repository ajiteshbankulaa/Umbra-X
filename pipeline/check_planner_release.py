"""Verify the compiled release before packaging it for a static host."""
import argparse
import hashlib
import json
import math
import struct
from datetime import datetime
from pathlib import Path

SITES = ("shackleton-ridge", "mons-mouton", "malapert-massif")


def check(root):
    shared = None
    fixture = json.loads((Path(__file__).parent / "fixtures/horizons-centers.json").read_text())
    by_site = {row["site"].replace("_", "-"): row for row in fixture["fixtures"]}
    for site in SITES:
        folder = root / site
        info = json.loads((folder / "planner.json").read_text(encoding="utf-8-sig"))
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8-sig"))
        assert info["schema"] == 1 and manifest["site_id"] == site, site
        assert info["stepMinutes"] == 5 and info["count"] == 8641, site
        assert datetime.fromisoformat(info["start"]) == datetime.fromisoformat(manifest["ephemeris"]["start_utc"]), site
        assert manifest["analysis_grid"]["spacing_m"] == 140 and len(info["observers"]) == 961, site
        regional = info["regional"]
        assert regional and regional["radiusM"] > regional["comparisonRadiusM"], site
        assert regional.get("localOverlapM") == 160, "Regional terrain predates overlap fix"
        assert info["start"] == fixture["epoch"] and info["frame"] == fixture["frame"], site
        assert info["kernels"] == fixture["kernels"], site
        stamp = (info["vectorHash"], info["start"], info["frame"], info["kernels"])
        assert shared is None or stamp == shared, "Mixed site releases"
        shared = stamp
        assets = {
            folder / "horizons.bin": (info["localHash"], 961*5*360*4),
            root / "planner" / (info["vectorHash"] + ".bin"): (info["vectorHash"], info["count"]*12*8),
        }
        for kind in ("regional", "distance", "coverage", "sensitivity"):
            digest = regional[kind]
            assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest), kind
            assets[root / "planner" / (digest + ".bin")] = (digest, 961*360*(1 if kind=="coverage" else 20))
        for path, (digest, length) in assets.items():
            payload = path.read_bytes()
            assert len(payload) == length and hashlib.sha256(payload).hexdigest() == digest, path
        vectors = (root / "planner" / (info["vectorHash"] + ".bin")).read_bytes()
        station = by_site[site]
        lat, lon = map(math.radians, (station["lat"], station["lon"]))
        up = (math.cos(lat)*math.cos(lon), math.cos(lat)*math.sin(lon), math.sin(lat))
        north = (-math.sin(lat)*math.cos(lon), -math.sin(lat)*math.sin(lon), math.cos(lat))
        east = (-math.sin(lon), math.cos(lon), 0.)
        worst = 0.
        for row in station["records"]:
            for body, offset in (("sun", 0), ("earth", 3)):
                vector = struct.unpack_from("<3d", vectors, (row["hour"]*12*12+offset)*8)
                target = [value - (1737400 + station["height_m"])*axis for value, axis in zip(vector, up)]
                n, e, u = [sum(a*b for a, b in zip(target, axis)) for axis in (north, east, up)]
                az = math.degrees(math.atan2(e, n))
                el = math.degrees(math.atan2(u, math.hypot(e, n)))
                worst = max(worst, abs((az-row[body+"_az_deg"]+180) % 360-180), abs(el-row[body+"_el_deg"]))
        assert worst <= .05, (site, worst)
        print(f"{site}: max pinned Horizons direction error {worst:.5f} deg")
    print("Verified all three regional site bundles and shared ephemeris.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    check(parser.parse_args().root)
