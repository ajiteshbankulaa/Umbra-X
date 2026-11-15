"""Compare release-case crossings against one-minute DE440 samples."""
import json
from datetime import datetime
from pathlib import Path

import numpy as np

from compile_planner import vectors
from fetch_nasa_data import CACHE
from umbra_x.compiler import MASTS, RADIUS

web = CACHE.parent.parent / "web/public"
root = web / "data/planner-release"
evidence = json.loads((web / "release-evidence.json").read_text())
checked = {}
for case in evidence["cases"]:
    for scenario in case["inputs"]["scenarios"]:
        key = tuple(scenario[k] for k in ("site", "node", "start", "mast"))
        if key in checked:
            continue
        site, node, start, mast = key
        meta = json.loads((root / site / "planner.json").read_text())
        checked[key] = meta
latest = max(start for _, _, start, _ in checked) + evidence["days"] * 24
epoch = datetime.fromisoformat(next(iter(checked.values()))["start"])
fine = vectors(CACHE / "kernels", epoch, latest * 60, 1)
results = []
for (site, node, start, mast), meta in checked.items():
    lat, lon, height = meta["observers"][node]
    lat, lon = np.deg2rad([lat, lon])
    up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    east = np.array([-np.sin(lon), np.cos(lon), 0])
    north = np.cross(up, east)
    profile = np.fromfile(root / "planner" / (meta["regional"]["regional"] + ".bin"), dtype="<f4").reshape(-1, 5, 360)[node, mast]
    samples = fine[start * 60:(start + evidence["days"] * 24) * 60]
    result = dict(site=site, pad=node + 1, startHours=start, mastM=float(MASTS[mast]))
    for body, offset in (("sun", 0), ("earth", 3)):
        directions = samples[:, offset:offset + 3] - (RADIUS + height + MASTS[mast]) * up
        az = np.rad2deg(np.arctan2(directions @ east, directions @ north)) % 360
        el = np.rad2deg(np.arctan2(directions @ up, np.hypot(directions @ east, directions @ north)))
        clearance = el - np.interp(az, np.arange(360), profile, period=360)
        if body == "sun":
            ratio = np.clip(clearance / .2665, -1, 1)
            visible = (np.arccos(-ratio) + ratio * np.sqrt(1 - ratio**2)) / np.pi >= .1
        else:
            visible = clearance > 0
        coarse = visible[::5]
        a = np.flatnonzero(visible[1:] != visible[:-1]) + 1
        b = (np.flatnonzero(coarse[1:] != coarse[:-1]) + 1) * 5
        shift = int(np.max(np.abs(a - b), initial=0)) if len(a) == len(b) else None
        result[body] = dict(eventShiftMinutes=shift, fineEvents=len(a), coarseEvents=len(b),
                            availabilityDeltaPoints=float(100 * (coarse.mean() - visible.mean())))
    results.append(result)
print(json.dumps(results, indent=2))
(web / "release-timing.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
assert all(row[body]["eventShiftMinutes"] is not None and row[body]["eventShiftMinutes"] <= 5
           for row in results for body in ("sun", "earth"))
