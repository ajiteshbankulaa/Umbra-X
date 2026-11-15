"""Independent ephemeris and 3-complex DSN validation on withheld non-center lunar pads.

Compares compiled DE440/MOON_ME_DE440_ME421 planner vectors (`vectors.bin`) against:
1. Live (or fixture-cached) JPL Horizons topocentric observer ephemerides (`APPARENT='AIRLESS'`),
   for withheld non-center, corner, elevated-ridge, and near-polar lunar coordinates.
2. Independent Skyfield evaluation from local NAIF kernels decomposing:
   - Binary/geometric parity (`vectors.bin` vs instantaneous geometric vector),
   - Light-time residual (astrometric `.observe()` minus geometric),
   - Stellar/planetary aberration residual (`.apparent()` minus `.observe()`),
   - Total apparent residual (`vectors.bin` vs JPL Horizons `APPARENT='AIRLESS'`).
3. Independent 3-complex NASA DSN (`DSS-14`, `DSS-63`, `DSS-43`) vector/normal orientation check
   and verification of `vectors.bin` Goldstone `DSS-14` columns.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import time

from jplephem.daf import DAF
from jplephem.pck import PCK
import numpy as np
import requests
from requests.adapters import HTTPAdapter
from skyfield.api import PlanetaryConstants, load, load_file
from skyfield.framelib import itrs
from urllib3.util.retry import Retry

from fetch_nasa_data import CACHE, HORIZONS
from umbra_x.compiler import RADIUS

ROOT = Path(__file__).resolve().parent.parent
RELEASE_DIR = ROOT / "web" / "public" / "data" / "planner-release"
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "horizons_withheld_pads.json"
BENCHMARK_OUT = Path(__file__).resolve().parent / "benchmarks" / "ephemeris_validation.json"

FRAME = "MOON_ME_DE440_ME421"
WGS84_A = 6378137.0
WGS84_B = 6356752.314245
DSN_COMPLEXES = {
    "DSS-14": [-2353621.365667699, -4641341.49114994, 3677052.329319744],
    "DSS-63": [4849092.518, -360180.348, 4115109.251],
    "DSS-43": [-4460894.92, 2682361.55, -3674748.58],
}
DEFAULT_MAST_M = 5.0
SAMPLE_STEPS = (0, 1, 672, 4320, 8639, 8640)
WITHHELD_NODES = {
    "shackleton-ridge": [0, 30, 180, 480, 960],
    "mons-mouton": [0, 16, 480, 930, 960],
    "malapert-massif": [0, 216, 480, 960],
}
POLAR_EXTREME = {"label": "polar-extreme-89.9S", "lat": -89.90, "lon": 45.0, "height_m": 1500.0}


def lunar_basis(lat_deg: float, lon_deg: float):
    """Return (east, north, up) unit vectors matching web/src/planner/model.ts basis()."""
    lt = np.deg2rad(lat_deg)
    ln = np.deg2rad(lon_deg)
    cl, sl = np.cos(lt), np.sin(lt)
    cn, sn = np.cos(ln), np.sin(ln)
    up = np.array([cl * cn, cl * sn, sl], dtype=np.float64)
    east = np.array([-sn, cn, 0.0], dtype=np.float64)
    north = np.array([-sl * cn, -sl * sn, cl], dtype=np.float64)
    return east, north, up


def vector_to_az_el(vec: np.ndarray, lat_deg: float, lon_deg: float, height_m: float, mast_m: float = DEFAULT_MAST_M):
    """Project Moon-centered body vector (m) to topocentric Az/El (deg) matching model.ts."""
    east, north, up = lunar_basis(lat_deg, lon_deg)
    obs = up * (RADIUS + height_m + mast_m)
    rel = vec - obs
    e = float(np.dot(rel, east))
    n = float(np.dot(rel, north))
    u = float(np.dot(rel, up))
    r = float(np.sqrt(e * e + n * n + u * u))
    az = float(np.degrees(np.arctan2(e, n)) % 360.0)
    el = float(np.degrees(np.arcsin(np.clip(u / r, -1.0, 1.0))))
    return az, el


def angular_sep_deg(az1: float, el1: float, az2: float, el2: float) -> float:
    a1, e1 = np.deg2rad(az1), np.deg2rad(el1)
    a2, e2 = np.deg2rad(az2), np.deg2rad(el2)
    v1 = np.array([np.cos(e1) * np.sin(a1), np.cos(e1) * np.cos(a1), np.sin(e1)])
    v2 = np.array([np.cos(e2) * np.sin(a2), np.cos(e2) * np.cos(a2), np.sin(e2)])
    return float(np.rad2deg(np.arccos(np.clip(np.dot(v1, v2), -1.0, 1.0))))


def load_withheld_targets(release_dir: Path):
    targets = []
    start_iso = None
    step_minutes = None
    vector_hash = None
    for site_id, nodes in WITHHELD_NODES.items():
        planner = json.loads((release_dir / site_id / "planner.json").read_text(encoding="utf-8"))
        start_iso = planner["start"]
        step_minutes = int(planner["stepMinutes"])
        vector_hash = planner["vectorHash"]
        observers = planner["observers"]
        for node in nodes:
            lat, lon, height_m = observers[node]
            role = "center-control" if node == 480 else f"withheld-node-{node}"
            targets.append({
                "id": f"{site_id}:node-{node}",
                "site": site_id,
                "node": node,
                "pad": node + 1,
                "role": role,
                "lat": float(lat),
                "lon": float(lon),
                "height_m": float(height_m),
                "mast_m": DEFAULT_MAST_M,
            })
    targets.append({
        "id": POLAR_EXTREME["label"],
        "site": "synthetic",
        "node": None,
        "pad": None,
        "role": "near-polar-extreme",
        "lat": POLAR_EXTREME["lat"],
        "lon": POLAR_EXTREME["lon"],
        "height_m": POLAR_EXTREME["height_m"],
        "mast_m": DEFAULT_MAST_M,
    })
    vec_path = release_dir / "planner" / f"{vector_hash}.bin"
    vectors = np.frombuffer(vec_path.read_bytes(), dtype="<f8").reshape(-1, 12)
    return start_iso, step_minutes, vector_hash, vectors, targets


def _horizons_session():
    s = requests.Session()
    s.mount("https://", HTTPAdapter(max_retries=Retry(
        total=3, backoff_factor=1.0, status_forcelist=(429, 500, 502, 503, 504),
    )))
    return s


def query_horizons_target(session: requests.Session, target: dict, body_code: str, epochs_utc: list[datetime]):
    tlist = " ".join(f"'{dt.strftime('%Y-%m-%d %H:%M')}'" for dt in epochs_utc)
    h_km = (target["height_m"] + target["mast_m"]) / 1000.0
    site_coord = f"{target['lon']:.8f},{target['lat']:.8f},{h_km:.6f}"
    resp = session.get(HORIZONS, params={
        "format": "json",
        "COMMAND": f"'{body_code}'",
        "CENTER": "'coord@301'",
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{site_coord}'",
        "TLIST": tlist,
        "QUANTITIES": "'4'",
        "APPARENT": "'AIRLESS'",
        "CSV_FORMAT": "'YES'",
    }, timeout=45)
    resp.raise_for_status()
    payload = resp.json()
    if "result" not in payload or "$$SOE" not in payload["result"]:
        raise RuntimeError(f"Horizons error for {target['id']} body={body_code}: {payload.get('message', payload)}")
    text = payload["result"]
    block = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0].strip().splitlines()
    rows = []
    for line in block:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        rows.append({
            "utc": parts[0],
            "az": float(parts[3]),
            "el": float(parts[4]),
        })
    if len(rows) != len(epochs_utc):
        raise RuntimeError(f"Expected {len(epochs_utc)} Horizons rows, got {len(rows)} for {target['id']}")
    return rows


def fetch_or_load_horizons(targets: list[dict], epochs_utc: list[datetime], offline: bool):
    if offline:
        if not FIXTURE_PATH.exists():
            raise FileNotFoundError(f"Offline mode requested but {FIXTURE_PATH} does not exist.")
        return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    session = _horizons_session()
    fixture = {
        "schema": 1,
        "source": HORIZONS,
        "apparent": "AIRLESS",
        "coordType": "GEODETIC",
        "lunarReferenceRadiusKm": RADIUS / 1000.0,
        "epochsUtc": [dt.isoformat().replace("+00:00", "Z") for dt in epochs_utc],
        "sampleSteps": list(SAMPLE_STEPS),
        "targets": {},
    }
    for target in targets:
        sun_rows = query_horizons_target(session, target, "10", epochs_utc)
        earth_rows = query_horizons_target(session, target, "399", epochs_utc)
        fixture["targets"][target["id"]] = {
            **target,
            "sun": sun_rows,
            "earth": earth_rows,
        }
        time.sleep(0.15)
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    return fixture


def evaluate_skyfield_decomposition(kernels_dir: Path, epochs_utc: list[datetime], targets: list[dict]):
    """Compute geometric, astrometric (light-time), and apparent (light-time + aberration) vectors."""
    constants = PlanetaryConstants()
    for name in ("moon_de440_250416.tf", "pck00011.tpc"):
        with (kernels_dir / name).open("rb") as stream:
            constants.read_text(stream)
    times = load.timescale().from_datetimes(epochs_utc)
    n = len(epochs_utc)
    geom_vecs = {"sun": np.empty((n, 3)), "earth": np.empty((n, 3))}
    obs_vecs = {"sun": np.empty((n, 3)), "earth": np.empty((n, 3))}
    app_vecs = {"sun": np.empty((n, 3)), "earth": np.empty((n, 3))}
    dsn_computed = {name: {"pos": np.empty((n, 3)), "up": np.empty((n, 3))} for name in DSN_COMPLEXES}

    with (kernels_dir / "moon_pa_de440_200625.bpc").open("rb") as stream, closing(
        load_file(str(kernels_dir / "de440s.bsp"))
    ) as planets:
        frame_id = constants.variables[f"FRAME_{FRAME}"]
        relative = constants.variables[f"TKFRAME_{frame_id}_RELATIVE"]
        relative_id = constants.variables[f"FRAME_{relative}"]
        remaining = np.ones(n, dtype=bool)
        for segment in reversed(PCK(DAF(stream)).segments):
            if segment.body != relative_id:
                continue
            mask = remaining & (segment.initial_jd <= times.tdb) & (times.tdb <= segment.final_jd)
            if not mask.any():
                continue
            t = times[mask]
            frame = constants.build_frame(frame_id, _segment=segment)
            moon_at = planets["moon"].at(t)
            for body in ("sun", "earth"):
                geom_vecs[body][mask] = (planets[body].at(t) - moon_at).frame_xyz(frame).m.T
                # Moon-centered light-time & apparent observations.
                astrometric = moon_at.observe(planets[body])
                obs_vecs[body][mask] = astrometric.frame_xyz(frame).m.T
                app_vecs[body][mask] = astrometric.apparent().frame_xyz(frame).m.T

            earth_rel_m = app_vecs["earth"][mask]
            # Independent 3-complex DSN transformation.
            rot = np.einsum("ijn,kjn->ikn", frame.rotation_at(t), itrs.rotation_at(t))
            wgs_sq = np.array([WGS84_A, WGS84_A, WGS84_B]) ** 2
            for name, xyz in DSN_COMPLEXES.items():
                st_m = np.einsum("ijn,j->in", rot, xyz).T
                axis = np.array(xyz, dtype=np.float64) / wgs_sq
                up = np.einsum("ijn,j->in", rot, axis / np.linalg.norm(axis)).T
                dsn_computed[name]["pos"][mask] = earth_rel_m + st_m
                dsn_computed[name]["up"][mask] = up
            remaining[mask] = False
        if remaining.any():
            raise ValueError("Kernels do not cover all validation epochs")

    return geom_vecs, obs_vecs, app_vecs, dsn_computed


def run_validation(offline: bool = False) -> dict:
    start_iso, step_minutes, vector_hash, vectors, targets = load_withheld_targets(RELEASE_DIR)
    start_dt = datetime.fromisoformat(start_iso)
    if start_dt.tzinfo is None:
        start_dt = start_dt.replace(tzinfo=timezone.utc)
    epochs_utc = [start_dt + timedelta(minutes=step_minutes * s) for s in SAMPLE_STEPS]

    fixture = fetch_or_load_horizons(targets, epochs_utc, offline=offline)
    kernels_dir = CACHE / "kernels"
    geom_vecs, obs_vecs, app_vecs, dsn_computed = evaluate_skyfield_decomposition(kernels_dir, epochs_utc, targets)

    # Check vectors.bin parity against live Skyfield apparent (LT+S) & DSN DSS-14.
    bin_slice = vectors[list(SAMPLE_STEPS)]
    sun_bin_app_diff = float(np.max(np.linalg.norm(bin_slice[:, 0:3] - app_vecs["sun"], axis=1)))
    earth_bin_app_diff = float(np.max(np.linalg.norm(bin_slice[:, 3:6] - app_vecs["earth"], axis=1)))
    dss14_pos_diff = float(np.max(np.linalg.norm(bin_slice[:, 6:9] - dsn_computed["DSS-14"]["pos"], axis=1)))
    dss14_up_diff = float(np.max(np.linalg.norm(bin_slice[:, 9:12] - dsn_computed["DSS-14"]["up"], axis=1)))

    # Per-target comparison & residual decomposition.
    per_target = []
    max_summary = {
        "sun_bin_vs_horizons_sep_deg": 0.0,
        "sun_bin_vs_horizons_daz_deg": 0.0,
        "sun_bin_vs_horizons_del_deg": 0.0,
        "sun_app_vs_horizons_sep_deg": 0.0,
        "sun_lighttime_deg": 0.0,
        "sun_aberration_deg": 0.0,
        "earth_bin_vs_horizons_sep_deg": 0.0,
        "earth_bin_vs_horizons_daz_deg": 0.0,
        "earth_bin_vs_horizons_del_deg": 0.0,
        "earth_app_vs_horizons_sep_deg": 0.0,
        "earth_lighttime_deg": 0.0,
        "earth_aberration_deg": 0.0,
    }
    dsn_max_pair_el_diff_deg = 0.0

    for tid, tdata in fixture["targets"].items():
        lat, lon, height_m, mast_m = tdata["lat"], tdata["lon"], tdata["height_m"], tdata["mast_m"]
        sun_errs = []
        earth_errs = []
        for idx, step_idx in enumerate(SAMPLE_STEPS):
            # Sun
            az_geom_s, el_geom_s = vector_to_az_el(geom_vecs["sun"][idx], lat, lon, height_m, mast_m)
            az_bin_s, el_bin_s = vector_to_az_el(bin_slice[idx, 0:3], lat, lon, height_m, mast_m)
            az_lt_s, el_lt_s = vector_to_az_el(obs_vecs["sun"][idx], lat, lon, height_m, mast_m)
            az_app_s, el_app_s = vector_to_az_el(app_vecs["sun"][idx], lat, lon, height_m, mast_m)
            az_hz_s, el_hz_s = tdata["sun"][idx]["az"], tdata["sun"][idx]["el"]
            sep_bin_hz_s = angular_sep_deg(az_bin_s, el_bin_s, az_hz_s, el_hz_s)
            sep_app_hz_s = angular_sep_deg(az_app_s, el_app_s, az_hz_s, el_hz_s)
            lt_deg_s = angular_sep_deg(az_geom_s, el_geom_s, az_lt_s, el_lt_s)
            ab_deg_s = angular_sep_deg(az_lt_s, el_lt_s, az_app_s, el_app_s)
            daz_s = abs(((az_bin_s - az_hz_s + 180.0) % 360.0) - 180.0)
            del_s = abs(el_bin_s - el_hz_s)
            sun_errs.append((sep_bin_hz_s, sep_app_hz_s, lt_deg_s, ab_deg_s, daz_s, del_s))

            max_summary["sun_bin_vs_horizons_sep_deg"] = max(max_summary["sun_bin_vs_horizons_sep_deg"], sep_bin_hz_s)
            max_summary["sun_bin_vs_horizons_daz_deg"] = max(max_summary["sun_bin_vs_horizons_daz_deg"], daz_s)
            max_summary["sun_bin_vs_horizons_del_deg"] = max(max_summary["sun_bin_vs_horizons_del_deg"], del_s)
            max_summary["sun_app_vs_horizons_sep_deg"] = max(max_summary["sun_app_vs_horizons_sep_deg"], sep_app_hz_s)
            max_summary["sun_lighttime_deg"] = max(max_summary["sun_lighttime_deg"], lt_deg_s)
            max_summary["sun_aberration_deg"] = max(max_summary["sun_aberration_deg"], ab_deg_s)

            # Earth
            az_geom_e, el_geom_e = vector_to_az_el(geom_vecs["earth"][idx], lat, lon, height_m, mast_m)
            az_bin_e, el_bin_e = vector_to_az_el(bin_slice[idx, 3:6], lat, lon, height_m, mast_m)
            az_lt_e, el_lt_e = vector_to_az_el(obs_vecs["earth"][idx], lat, lon, height_m, mast_m)
            az_app_e, el_app_e = vector_to_az_el(app_vecs["earth"][idx], lat, lon, height_m, mast_m)
            az_hz_e, el_hz_e = tdata["earth"][idx]["az"], tdata["earth"][idx]["el"]
            sep_bin_hz_e = angular_sep_deg(az_bin_e, el_bin_e, az_hz_e, el_hz_e)
            sep_app_hz_e = angular_sep_deg(az_app_e, el_app_e, az_hz_e, el_hz_e)
            lt_deg_e = angular_sep_deg(az_geom_e, el_geom_e, az_lt_e, el_lt_e)
            ab_deg_e = angular_sep_deg(az_lt_e, el_lt_e, az_app_e, el_app_e)
            daz_e = abs(((az_bin_e - az_hz_e + 180.0) % 360.0) - 180.0)
            del_e = abs(el_bin_e - el_hz_e)
            earth_errs.append((sep_bin_hz_e, sep_app_hz_e, lt_deg_e, ab_deg_e, daz_e, del_e))

            max_summary["earth_bin_vs_horizons_sep_deg"] = max(max_summary["earth_bin_vs_horizons_sep_deg"], sep_bin_hz_e)
            max_summary["earth_bin_vs_horizons_daz_deg"] = max(max_summary["earth_bin_vs_horizons_daz_deg"], daz_e)
            max_summary["earth_bin_vs_horizons_del_deg"] = max(max_summary["earth_bin_vs_horizons_del_deg"], del_e)
            max_summary["earth_app_vs_horizons_sep_deg"] = max(max_summary["earth_app_vs_horizons_sep_deg"], sep_app_hz_e)
            max_summary["earth_lighttime_deg"] = max(max_summary["earth_lighttime_deg"], lt_deg_e)
            max_summary["earth_aberration_deg"] = max(max_summary["earth_aberration_deg"], ab_deg_e)

            # Check lunar observer elevation angle above each DSN station horizon.
            _, _, up_obs = lunar_basis(lat, lon)
            obs_moon = up_obs * (RADIUS + height_m + mast_m)
            for name in DSN_COMPLEXES:
                los = obs_moon - dsn_computed[name]["pos"][idx]
                up_dsn = dsn_computed[name]["up"][idx]
                el_dsn = float(np.degrees(np.arcsin(np.clip(np.dot(los, up_dsn) / np.linalg.norm(los), -1.0, 1.0))))
                if name == "DSS-14":
                    los_bin = obs_moon - bin_slice[idx, 6:9]
                    up_bin = bin_slice[idx, 9:12]
                    el_bin_dsn = float(np.degrees(np.arcsin(np.clip(np.dot(los_bin, up_bin) / np.linalg.norm(los_bin), -1.0, 1.0))))
                    dsn_max_pair_el_diff_deg = max(dsn_max_pair_el_diff_deg, abs(el_dsn - el_bin_dsn))

        per_target.append({
            "id": tid,
            "site": tdata["site"],
            "role": tdata["role"],
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "heightM": round(height_m, 3),
            "mastM": mast_m,
            "sunMaxBinVsHorizonsSepDeg": round(max(x[0] for x in sun_errs), 6),
            "sunMaxAppVsHorizonsSepDeg": round(max(x[1] for x in sun_errs), 6),
            "sunMaxLightTimeDeg": round(max(x[2] for x in sun_errs), 6),
            "sunMaxAberrationDeg": round(max(x[3] for x in sun_errs), 6),
            "earthMaxBinVsHorizonsSepDeg": round(max(x[0] for x in earth_errs), 6),
            "earthMaxAppVsHorizonsSepDeg": round(max(x[1] for x in earth_errs), 6),
            "earthMaxLightTimeDeg": round(max(x[2] for x in earth_errs), 6),
            "earthMaxAberrationDeg": round(max(x[3] for x in earth_errs), 6),
        })

    report = {
        "schema": 1,
        "offline": offline,
        "vectorHash": vector_hash,
        "frame": FRAME,
        "sampleSteps": list(SAMPLE_STEPS),
        "epochsUtc": fixture["epochsUtc"],
        "targetCount": len(targets),
        "vectorsBinParity": {
            "ephemerisModel": "apparent (LT+S)",
            "sunMaxPositionDiffMeters": sun_bin_app_diff,
            "earthMaxPositionDiffMeters": earth_bin_app_diff,
            "dss14MaxPositionDiffMeters": dss14_pos_diff,
            "dss14MaxNormalDiffUnit": dss14_up_diff,
            "dss14MaxLunarElevationDiffDeg": dsn_max_pair_el_diff_deg,
        },
        "maxResiduals": {k: round(v, 6) for k, v in max_summary.items()},
        "targets": per_target,
    }
    BENCHMARK_OUT.parent.mkdir(parents=True, exist_ok=True)
    BENCHMARK_OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Use cached Horizons fixture instead of live API.")
    args = parser.parse_args()
    report = run_validation(offline=args.offline)
    mr = report["maxResiduals"]
    vp = report["vectorsBinParity"]
    print(f"Validated {report['targetCount']} withheld/control targets x {len(report['sampleSteps'])} epochs:")
    print(f"  vectors.bin apparent (LT+S) max diff (Sun/Earth m): {vp['sunMaxPositionDiffMeters']:.3e} / {vp['earthMaxPositionDiffMeters']:.3e}")
    print(f"  DSS-14 max pos diff (m) / normal diff: {vp['dss14MaxPositionDiffMeters']:.3e} / {vp['dss14MaxNormalDiffUnit']:.3e}")
    print(f"  Sun   bin vs Horizons AIRLESS max sep: {mr['sun_bin_vs_horizons_sep_deg']:.6f} deg (light-time={mr['sun_lighttime_deg']:.6f}, aberration={mr['sun_aberration_deg']:.6f}, Skyfield-apparent vs Horizons={mr['sun_app_vs_horizons_sep_deg']:.6f})")
    print(f"  Earth bin vs Horizons AIRLESS max sep: {mr['earth_bin_vs_horizons_sep_deg']:.6f} deg (light-time={mr['earth_lighttime_deg']:.6f}, aberration={mr['earth_aberration_deg']:.6f}, Skyfield-apparent vs Horizons={mr['earth_app_vs_horizons_sep_deg']:.6f})")


if __name__ == "__main__":
    main()
