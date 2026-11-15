# Reproducibility & Verification Guide

All commands below assume Windows PowerShell at repository root `UmbraX/` with `.venv` (Python 3.11+ with `numpy`, `numba`, `rasterio`, `pyproj`, `skyfield`, `jplephem`, `pytest`), Node 24+, and Rust (`wasm32-unknown-unknown` target installed).

## 1. Quick Offline Verification Suite (No Network Required)

Run the full automated verification across Python geometry/ephemeris/convergence tests, bundle SHA-256 integrity, Rust/WASM kernel tests, Web model/confidence tests, and production TypeScript + Vite build:

```powershell
# 1. Python scientific & regression tests (including offline withheld-pad Horizons & convergence tests)
.\.venv\Scripts\python.exe -m pytest pipeline -q

# 2. Validate regional bundle SHA-256 digests, localOverlapM=160, & center Horizons parity
.\.venv\Scripts\python.exe pipeline/check_planner_release.py web/public/data/planner-release

# 3. Rust/WASM search kernel unit tests
cargo test --locked --manifest-path rust/umbra-core/Cargo.toml

# 4. Web planner physics, confidence classification, & study interpreter tests
npm --prefix web test

# 5. Deterministic research agent, security, & queue durability server tests
node --test server/research.test.mjs server/agent.test.mjs server/phase5.test.mjs

# 6. Verify Web vs Rust/WASM release eligibility parity (61,824 pairs at 5m mast / 0-sigma)
node web/src/planner/benchmark.mjs

# 7. Type-check, build production bundle, & verify SHA-256 release integrity manifest
npm --prefix web run build
node infra/scripts/verify_release_integrity.mjs
docker compose -f infra/docker-compose.yml config -q
```

## 2. Live Upstream Validation & Numerical Benchmarks

To re-query JPL Horizons (`APPARENT='AIRLESS'`) across the 15 withheld non-center/polar targets (`pipeline/fixtures/horizons_withheld_pads.json`) and regenerate all validation tables:

```powershell
# Live Horizons query -> pipeline/benchmarks/ephemeris_validation.json
.\.venv\Scripts\python.exe pipeline/validate_ephemeris.py

# Offline replay of withheld-pad validation from saved fixture
.\.venv\Scripts\python.exe pipeline/validate_ephemeris.py --offline

# 5-pad convergence & sensitivity suite -> pipeline/benchmarks/convergence_benchmark.json
.\.venv\Scripts\python.exe pipeline/benchmark_convergence.py
```

## 3. Full Data Rebuild from Upstream NASA Sources

1. Fetch NASA PGDA terrain windows (`dem_elev`, `dem_err`, `lola_slope`, `psr`), NAIF DE440 kernels, and center Horizons fixtures:
   ```powershell
   .\.venv\Scripts\python.exe pipeline/fetch_nasa_data.py
   ```
   *(If remote HTTP range reads fail on PGDA GeoTIFFs, download the four `LOLA_20mpp`GeoTIFFs locally and pass `--raster-dir <folder>`.)*
2. Compile local `20 m` horizons and extend to `96 km` regional profiles (`localOverlapM = 160`):
   ```powershell
   .\.venv\Scripts\python.exe pipeline/compile_horizons.py --grid expanded --output web/public/data/planner-release
   .\.venv\Scripts\python.exe pipeline/compile_planner.py --output web/public/data/planner-release
   .\.venv\Scripts\python.exe pipeline/check_planner_release.py web/public/data/planner-release
   ```
3. Optional Rust/WASM rebuild (checked binary at `web/public/wasm/umbra_core.wasm`):
   ```powershell
   cargo build --locked --release --target wasm32-unknown-unknown --manifest-path rust/umbra-core/Cargo.toml
   ```
4. Launch development preview (with optional `/api/polar-horizon` Python sidecar):
   ```powershell
   npm --prefix web run dev -- --host 127.0.0.1 --port 5174
   ```
