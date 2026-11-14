"""Check planner geometry against the existing Horizons tables and report terrain sensitivity."""
import json
from datetime import datetime

import numpy as np

from compile_planner import vectors as build_vectors
from fetch_nasa_data import CACHE, POLAR_SITES
from umbra_x.compiler import RADIUS

root = CACHE.parent.parent / "web/public/data/planner-release"
reference = None
for site in POLAR_SITES:
    folder = root / site.id.replace("_", "-")
    meta = json.loads((folder / "planner.json").read_text(encoding="utf-8"))
    table = json.loads((CACHE / f"{site.id}_ephemeris.json").read_text(encoding="utf-8"))
    vectors = np.fromfile(root / "planner" / (meta["vectorHash"] + ".bin"), dtype="<f8").reshape(-1,12)
    lat, lon = np.deg2rad([site.lat, site.lon])
    u = np.array([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])
    e = np.array([-np.sin(lon), np.cos(lon), 0])
    n = np.cross(u, e)
    for key, offset in (("sun",0), ("earth",3)):
        direction = vectors[:8640:12,offset:offset+3] - RADIUS*u
        az = np.rad2deg(np.arctan2(direction@e,direction@n))
        el = np.rad2deg(np.arctan2(direction@u,np.hypot(direction@e,direction@n)))
        error = np.max(np.abs((az-np.array(table[key+"_az_deg"])+180)%360-180))
        elevation_error = np.max(np.abs(el-table[key+"_el_deg"]))
        print(site.id, key, f"az max {error:.5f}°, el max {elevation_error:.5f}°")
        assert max(error,elevation_error)<.05
    if meta["regional"]:
        profiles = []
        for key in ("regional","sensitivity"):
            path = root / "planner" / (meta["regional"][key]+".bin")
            profiles.append(np.fromfile(path,dtype="<f4"))
        local = np.fromfile(folder / "horizons.bin",dtype="<f4")
        for label, baseline in (("local",local),("48 km",profiles[1])):
            change = profiles[0]-baseline
            print(f"  96 km vs {label}: {np.count_nonzero(change>.05):,} bins change >0.05°, max {change.max():.3f}°")
        if reference is None:
            reference = build_vectors(CACHE / "kernels", datetime.fromisoformat(meta["start"]), 17*24*60, 1)
        lat, lon, height = meta["observers"][480]
        lat, lon = np.deg2rad([lat, lon])
        u = np.array([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])
        e = np.array([-np.sin(lon), np.cos(lon), 0])
        n = np.cross(u, e)
        horizon = profiles[0].reshape(961,5,360)[480,2]
        for start in (0,48*60):
            for key,offset,threshold in (("Sun",0,-.183),("Earth",3,0)):
                direction = reference[start:start+15*24*60,offset:offset+3] - (RADIUS+height+5)*u
                az = np.rad2deg(np.arctan2(direction@e,direction@n))%360
                el = np.rad2deg(np.arctan2(direction@u,np.hypot(direction@e,direction@n)))
                visible = el-np.interp(az,np.arange(360),horizon,period=360) >= threshold
                coarse = visible[::5]
                fine_events = np.flatnonzero(visible[1:] != visible[:-1])+1
                coarse_events = 5*(np.flatnonzero(coarse[1:] != coarse[:-1])+1)
                timing = (str(np.max(np.abs(fine_events-coarse_events), initial=0))+" min"
                          if len(fine_events)==len(coarse_events) else "event count differs")
                print(f"  pad 481 {key}, start +{start//60} h: "
                      f"5 vs 1 min availability {100*(coarse.mean()-visible.mean()):+.3f} pp, event shift {timing}")
                if key == "Sun":
                    margin = el-np.interp(az,np.arange(360),horizon,period=360)
                    candidates = np.argsort(np.abs(margin))[:32]
                    axis = (np.arange(201)+.5)/201*2-1
                    xx, yy = np.meshgrid(axis, axis)
                    disk = xx**2+yy**2 <= 1
                    delta_az = xx[disk]*.2665/np.cos(np.deg2rad(el[candidates,None]))
                    limb = el[candidates,None]+yy[disk]*.2665
                    silhouette = np.interp(az[candidates,None]+delta_az,np.arange(360),horizon,period=360)
                    integrated = np.mean(limb >= silhouette, axis=1)
                    ratio = np.clip(margin[candidates]/.2665,-1,1)
                    straight = (np.arccos(-ratio)+ratio*np.sqrt(1-ratio**2))/np.pi
                    print(f"    2D disk vs straight skyline at nearest crossings: max "
                          f"{100*np.max(np.abs(integrated-straight)):.2f} pp")
