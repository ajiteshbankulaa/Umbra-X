"""Bake lightweight NASA LRO LOLA South-Pole terrain textures from LDEM_80S_80MPP_ADJ.TIF for IntroScene."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer
import rasterio
from rasterio.enums import Resampling

from umbra_x.compiler import CRS_POLAR, RADIUS

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TIF = ROOT / "pipeline" / "cache" / "LDEM_80S_80MPP_ADJ.TIF"
OUT_DIR = ROOT / "web" / "public" / "textures"

SITES = {
    "shackleton-ridge": (-89.450, 222.000),
    "mons-mouton": (-84.790, 29.200),
    "malapert-massif": (-86.040, 2.700),
}


def compute_hillshade(elev_m: np.ndarray, px_m: float, sun_az_deg: float = 42.0, sun_el_deg: float = 11.0) -> np.ndarray:
    """Compute Lambertian + ambient Lunar South-Pole hillshade normalized to [0, 1]."""
    gy, gx = np.gradient(elev_m.astype(np.float64), px_m)
    # Row index increases southward (-y in North-up GeoTIFF), so negate gy for world +Y up.
    nx = -gx
    ny = gy
    nz = np.ones_like(nx)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    nx *= inv_len
    ny *= inv_len
    nz *= inv_len

    az = math.radians(sun_az_deg)
    el = math.radians(sun_el_deg)
    sx = math.cos(el) * math.sin(az)
    sy = math.cos(el) * math.cos(az)
    sz = math.sin(el)

    lambert = np.clip(nx * sx + ny * sy + nz * sz, 0.0, 1.0)
    # Mix crisp grazing key light with subtle lunar earthshine ambient so crater bowls stay legible.
    shaded = 0.14 + 0.86 * (lambert ** 0.85)
    return np.clip(shaded, 0.0, 1.0)


def bake_textures(tif_path: Path = DEFAULT_TIF, out_dir: Path = OUT_DIR, size: int = 1024) -> dict:
    if not tif_path.exists():
        raise FileNotFoundError(f"Missing NASA LOLA raster: {tif_path}")
    out_dir.mkdir(parents=True, exist_ok=True)

    with rasterio.open(tif_path) as src:
        elev = src.read(1, out_shape=(size, size), resampling=Resampling.bilinear).astype(np.float32)
        scale = float(src.scales[0]) if src.scales else 1.0
        offset = float(src.offsets[0]) if src.offsets else 0.0
        if scale != 1.0 or offset != 0.0:
            elev = elev * scale + offset
        bounds = src.bounds
        left, bottom, right, top = float(bounds.left), float(bounds.bottom), float(bounds.right), float(bounds.top)

    finite_vals = elev[np.isfinite(elev)]
    lo = float(np.percentile(finite_vals, 0.25))
    hi = float(np.percentile(finite_vals, 99.75))
    elev_clean = np.where(np.isfinite(elev), elev, lo)

    # Heightmap PNG (0..255) for real 3D polar-cap vertex displacement
    height_norm = np.clip((elev_clean - lo) / max(1.0, hi - lo), 0.0, 1.0)
    height_u8 = np.round(height_norm * 255.0).astype(np.uint8)
    Image.fromarray(height_u8, mode="L").save(out_dir / "lola_spole_height.png", optimize=True)

    # Regolith albedo + grazing hillshade + gentle hypsometric contrast
    px_m = (right - left) / float(size)
    shade = compute_hillshade(elev_clean, px_m=px_m, sun_az_deg=42.0, sun_el_deg=11.0)
    base_regolith = 0.22 + 0.48 * shade + 0.22 * height_norm
    albedo_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    lum = np.clip(base_regolith, 0.06, 0.96)
    albedo_rgb[..., 0] = np.round(lum * 238.0).astype(np.uint8)
    albedo_rgb[..., 1] = np.round(lum * 241.0).astype(np.uint8)
    albedo_rgb[..., 2] = np.round(lum * 246.0).astype(np.uint8)
    Image.fromarray(albedo_rgb, mode="RGB").save(out_dir / "lola_spole_albedo.png", optimize=True)

    # Fast circular polar preview (512x512 RGBA with clean circular edge falloff for instant splash paint)
    prev_size = 512
    yy, xx = np.mgrid[0:prev_size, 0:prev_size]
    cx = (prev_size - 1) / 2.0
    r_norm = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cx) / cx) ** 2)
    alpha = np.clip((1.0 - r_norm) * 28.0, 0.0, 1.0)
    prev_img = Image.fromarray(albedo_rgb, mode="RGB").resize((prev_size, prev_size), Image.Resampling.LANCZOS)
    prev_arr = np.asarray(prev_img, dtype=np.uint8)
    rgba = np.dstack([prev_arr, np.round(alpha * 255.0).astype(np.uint8)])
    Image.fromarray(rgba, mode="RGBA").save(out_dir / "lola_spole_preview.png", optimize=True)

    transformer = Transformer.from_crs(CRS_POLAR.geodetic_crs, CRS_POLAR, always_xy=True)
    site_meta = {}
    for site_id, (lat, lon) in SITES.items():
        xm, ym = transformer.transform(lon, lat)
        u = (xm - left) / (right - left)
        v = (top - ym) / (top - bottom)
        site_meta[site_id] = {
            "lat": lat,
            "lon": lon,
            "xM": round(float(xm), 1),
            "yM": round(float(ym), 1),
            "u": round(float(u), 6),
            "v": round(float(v), 6),
        }

    meta = {
        "source": "NASA GSFC PGDA LDEM_80S_80MPP_ADJ.TIF",
        "sourceUrl": "https://pgda.gsfc.nasa.gov/data/LOLA_80mpp/LDEM_80S_80MPP_ADJ.TIF",
        "radiusM": RADIUS,
        "leftM": left,
        "rightM": right,
        "bottomM": bottom,
        "topM": top,
        "minElevM": round(lo, 1),
        "maxElevM": round(hi, 1),
        "textureSize": size,
        "sites": site_meta,
    }
    (out_dir / "lola_spole_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


if __name__ == "__main__":
    summary = bake_textures()
    print(json.dumps(summary, indent=2))
