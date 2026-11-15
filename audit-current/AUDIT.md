# Umbra-X current-state audit — 2026-11-14

Scope: current uncommitted local application, source inspection, fresh browser captures, and local test execution. No product code changed. Challenge requirements supplied by the user are the comparison baseline; the challenge URL returned HTTP 502 during verification.

## Assessment

Strong challenge alignment and substantial NASA data integration. A useful research/education prototype, not yet a validated operational decision system. Indicative review scores (not official judging): relevance 4.5/5, creativity 4/5, validity 3/5, impact 3/5, presentation 3.5/5; total 18/25. Visual craft 7/10, first-use usability 6/10, technical prototype 7/10, operational readiness 4/10, portfolio potential as currently evidenced 8/10.

## Fresh checks

- npm test: 16 passed, including a test containing 22 deterministic explanation cases.
- npm run build: passed.
- .venv/Scripts/python.exe -m pytest pipeline -q: 11 passed, four Skyfield/NumPy deprecation warnings.
- Release bundle checker: all three bundles verified.
- cargo test: two Rust tests passed.
- Previous runtime/performance numbers in PLANNER.md were inspected but not rerun in this audit.

## Captured flow

1. Existing mast comparison and Methods: useful metrics and rendering; dense controls (01-current.png).
2. 48-hour delay: calculations update; preset incorrectly becomes Custom comparison; decision paragraph remains dense (02-delay.png).
3. Intro: distinctive restrained composition; role and camera choices precede any result; 2,883 sites should say candidate pads across three regions (03-intro.png).
4. Public at 390 × 844: fits width, but control stack and comparisons push sky below first screen; battery unit wraps awkwardly (04-mobile-public.png).
5. Educator switch: preserves scenarios but title claims Apollo comparison when both remain Shackleton (05-educator.png).

## Priority findings

P1: Regional integration has an unsampled near-field gap at edge pads. pipeline/compile_planner.py:77 starts every regional ray at 1,800 m; pipeline/umbra_x/compiler.py stops local rays at tile bounds. Expanded grid edge pads are about 440–460 m from some boundaries. Terrain between local exit and 1,800 m can be missed while coverage remains complete. Impact on current mission outputs not measured. Fix continuous overlap, add a synthetic ridge in the gap, recompile and rerun search/benchmark.

P1: web/src/planner/data.ts:133 attaches local horizons_err to regional horizons. This is not a propagated uncertainty model for a new regional occluder. Distinguish local error sensitivity from calibrated regional uncertainty or compile appropriate regional envelopes.

P1: Labels conflate geometric visibility and communications. Planner.tsx:636 says Earth direct comm; :1744 says ridge blackout even for below-level-horizon events. Use Earth-center visibility/obstruction. Station coverage checks currently use Sun/Earth azimuths but not station azimuth (model.ts:124); add station-specific unknown coverage handling.

P1: CI checks build/tests but does not build/test Rust or run the real bundle gate. NASA reference tests skip when caches are absent. Add a separate pinned release-data validation job and required offline fixtures.

P2: Search returns earliest passing start for each pad, sorts by start then slope, and keeps 12. This is feasible-alternative enumeration, not global battery/cost optimization. Explain objective and expose feasible intervals/Pareto trade-offs.

P2: Search label says 720 starts although valid starts depend on duration. A 30-day bundle supporting a 15-day window has 361 inclusive hourly starts. Generate labels from actual bounds.

P2: Solar countdown uses the <10% disk threshold but labels the crossing sunset/sunrise. Label low-light threshold crossings explicitly or calculate astronomical limb events separately.

P2: Window-clipped outages need prominence in headline interpretation. The observed 103.7 to 55.7 hour difference is a mission-window result, not a claim that the physical eclipse became 48 hours shorter.

P2: Two overlapping experiment selectors, duplicated metric summaries, and technical public controls weaken hierarchy. Keep one experiment selector and a single short decision sentence, with deeper methods below.

P2: Educator title must reflect actual comparison. Preserve user state but offer an explicit Load Apollo lesson action.

P2: Accessible canvas tree exposes WebGL unavailable text while screenshots show rendering. Fix canvas accessible description and test screen-reader behavior; do not infer a render failure from fallback text.

## NASA evidence and claim boundaries

fetch_nasa_data.py calls the official JPL Horizons API; test_ephemeris.py checks four sites against cached observer tables at 0.05 degree tolerance. The planner compiles DE440/NAIF lunar-frame vectors and derives topocentric directions. LOLA local/regional terrain controls obstruction. This is substantive use, including Horizons from the supplied challenge list. Moon Trek/QuickMap links are external context, not proof of ingesting their services. Do not claim Diviner/ShadowCam measured products where only literature-inspired models are used.

## Portfolio claims

Strong evidence: scientific Python/Numba, raster geospatial transforms, React/TypeScript/Three.js, workers, Rust/WASM search, content hashes, tests, deterministic scenario-grounded explanation, conditional economics.

Do not claim implemented PyTorch/ONNX, LangGraph/GraphRAG, production cloud/Terraform, operational communications validation, or user adoption based on the inspected code. Rust FFI uses unsafe global state and raw pointers; document its single-worker assumptions rather than claiming blanket memory safety. Benchmarks documented previously need a named environment and reproducible output artifact.

## Next release gate

Fix continuous terrain coverage and uncertainty claims first. Recompute recommendation changes. Correct event/communications labels. Unify experiment state and role-specific hierarchy. Wire Rust and release-data checks into CI. Publish a reproducible launch-delay example, a passing alternative and a no-feasible case. Then run the five-participant study, deploy a clean build with data, and record the demo.

Limits: no full screen-reader/keyboard/contrast audit, observed-shadow validation, independent station check, public deployment test, or fresh performance benchmark was completed here. Screenshots establish layout observations, not WCAG compliance. Current tests establish implemented-case correctness, not operational reliability.
