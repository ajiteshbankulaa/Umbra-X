"""Verify the compiled release before packaging it for a static host."""
import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path

SITES = ("shackleton-ridge", "mons-mouton", "malapert-massif")


def check(root):
    shared = None
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
    print("Verified all three regional site bundles and shared ephemeris.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    check(parser.parse_args().root)
