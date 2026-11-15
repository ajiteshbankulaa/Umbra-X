"""Request-driven HTTP adapter for the existing polar terrain calculator."""
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from live_terrain import DEFAULT_TIF, PolarTerrainService


def parse_query(query):
    values = parse_qs(query)
    allowed = {"lat", "lon", "mast", "max_dist_m"}
    if set(values) - allowed or any(len(v) != 1 for v in values.values()):
        raise ValueError("Unknown or repeated terrain parameter")
    lat = float(values["lat"][0])
    lon = float(values["lon"][0])
    mast = float(values.get("mast", ["5"])[0])
    radius = int(values.get("max_dist_m", ["96000"])[0])
    if not all(math.isfinite(v) for v in (lat, lon, mast)):
        raise ValueError("Coordinates and mast must be finite")
    if not -90 <= lat <= -80 or not -180 <= lon <= 360 or not 0 <= mast <= 50:
        raise ValueError("Coordinates or mast outside supported range")
    if radius not in (48000, 96000, 144000):
        raise ValueError("Supported terrain radii are 48000, 96000, and 144000 meters")
    return lat, (lon + 180) % 360 - 180, mast, radius


def create_handler(service):
    @lru_cache(maxsize=128)
    def calculate(lat, lon, mast, radius):
        return service.query(lat, lon, mast, radius)

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            payload = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == "/healthz":
                return self.reply(200, {"ok": True, "warmed": bool(getattr(service, "_warmed", False))})
            if url.path not in ("/api/polar-horizon", "/api/horizon"):
                return self.reply(404, {"error": "Unknown route"})
            try:
                parameters = parse_query(url.query)
            except (KeyError, ValueError, OverflowError):
                return self.reply(400, {"supported": False, "error": "Invalid terrain query"})
            try:
                result = calculate(*parameters)
                self.reply(200, result)
            except (OSError, ValueError):
                self.reply(503, {"supported": False, "error": "Terrain calculation unavailable"})

    return Handler


def warmup_service(service: PolarTerrainService) -> bool:
    """Preload the GeoTIFF and compile Numba kernels before serving HTTP traffic."""
    try:
        service.query(-89.45, -138.0, 5.0, 96000)
        service._warmed = True
        return True
    except (OSError, ValueError):
        service._warmed = False
        return False


if __name__ == "__main__":
    terrain = PolarTerrainService(Path(os.environ.get("UMBRA_TERRAIN_TIF", DEFAULT_TIF)), preload=False)
    if os.environ.get("UMBRA_TERRAIN_PREWARM", "1") != "0":
        warmup_service(terrain)
    HTTPServer((os.environ.get("UMBRA_HOST", "127.0.0.1"), int(os.environ.get("PORT", "8788"))), create_handler(terrain)).serve_forever()
