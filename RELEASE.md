# Umbra-X release evidence

## Decision walkthrough

Open the default 15-day Shackleton comparison. A delay from 14 to 16 November 2026 reduces the longest in-window Earth-center obstruction from 103.7 to 55.7 hours at pad 481, crossing the 72-hour limit. The 52.25-hour (52.3 h) low-light interval still exceeds the 48-hour limit, and the pad exceeds the 5-degree slope limit. Inspect the obstruction, then select **Try nearby Pad #479**. The app holds the November 16 start fixed across both pads and computes 0 hours of low light, 4.83 hours of Earth-center obstruction, and 0.94 degrees of coarse slope at Pad #479. Use `?replay=delay` and `?replay=nearby` to enter either step directly. Battery estimates use the shared example load and ideal tracked solar array.

The app’s **Reproduce a decision** section (open Detailed display) has four version-pinned links. Pad 217 is the trade-off case. It improves Earth-center visibility while raising required storage mass from 56.9 to 96.1 kg. The zero-outage, zero-slope case is a deliberately strict stress test with zero eligible pairs in the searched domain.

## Validation

At 5 m mast height and 15 days, the three-region search identifies 61,824 eligible pad/start pairs (169 Mons Mouton pairs removed by `localOverlapM = 160` correction; at pad 17, 16 November 19:00 UTC, adding samples beyond the fine tile boundary increased longest low-light interval from 45.08 to 48.58 hours). The before/after comparison holds the data epoch, limits, mast and time grid constant.

The pinned Horizons reference checks hourly site centers, and independent withheld-pad validation ([`pipeline/validate_ephemeris.py`](pipeline/validate_ephemeris.py), 15 withheld/corner/ridge/polar targets × 6 epochs) matches JPL Horizons `AIRLESS` apparent (LT+S) topocentric angles to `<= 0.000001°` (Sun) and `<= 0.000025°` (Earth). Multi-parameter convergence (`0.25°/0.5°/1.0°`, `48/96/120/144 km`, `80m-only` vs hybrid, `1-min` vs `5-min`, 2D disk, mast heights, `0σ–3σ`, slope definitions) is documented in [`docs/VALIDATION_MATRIX.md`](docs/VALIDATION_MATRIX.md). Independent observed-shadow imagery validation (LROC NAC / ShadowCam), RF link/scheduling verification, and human participant testing remain open publication gates.

- Geometry data and thresholds: web/public/release-evidence.json
- Sampling benchmark: web/public/release-timing.json
- NASA data: LRO LOLA PGDA, JPL DE440/NAIF and Horizons observer tables.
- Credit: see PLANNER.md and in-app Methods. This revision used OpenAI Codex for implementation and verification.
- Co-Pilot uses local keyword and sparse-vector retrieval with deterministic scenario answers. The portfolio system consists of the compiled geospatial dataset, versioned browser worker, Rust/WASM search, and the TypeScript fallback. The current index runs in memory and uses no managed vector service.

## Participant protocol

Results: pending, zero participants observed. Recruit five consenting participants, including one technical reviewer. Without coaching, ask each to compare the 48-hour slip, identify the changed constraint, and explain Earth-center visibility. Record participant number, role, seconds, completion, explanation, and one point of friction. The target is four of five succeeding within two minutes. Fix the most frequent issue and rerun the affected task.

Ask the technical reviewer to reproduce one export using the recorded source products and settings. Have them separately solve the comparable question with source tools. Record tool names, steps, elapsed time, assumptions, and which outputs can be compared. Record actual results after the sessions.

## Deploy the frozen build

Build and stage a clean public directory. The staging script selects only the terrain binaries referenced by the three active manifests; it leaves historic bundles in the development cache.

```powershell
npm.cmd --prefix web run build
node infra/scripts/stage_static_release.mjs web/dist public-release
node infra/scripts/check_static_package.mjs public-release
```

The last two commands require a new staging directory. Upload its contents (or unpack the generated deployment archive) at an HTTPS site root. Keep `assets/`, `data/`, `textures/` and `wasm/` adjacent to `index.html`. Open `?replay=delay` in a private window, follow Pad #479, inspect the 2D chart, and download Events CSV on desktop and mobile. Submit the captioned demo as a separate public link. The two judge replays need no API keys or remote services; the agent and live custom-coordinate terrain use the optional services in `infra/docker-compose.yml`.

## Corrected search benchmark

Measured on Windows with an Intel Core i7-1355U and Node 24.11.0. The workload covers three regions, 961 pads each, 48 km and 96 km horizons, and 361 possible hourly starts for a 15-day mission. Seven runs per implementation include one cold and six warm runs.

| Search engine | Cold | Warm median | Warm p95 |
|---|---:|---:|---:|
| Reference TypeScript | 5.63 s | 6.08 s | 8.51 s |
| Optimized TypeScript | 2.21 s | 2.66 s | 4.12 s |
| Rust/WASM | 1.63 s | 2.40 s | 3.16 s |

Exact search decisions matched for the six exercised mast and local-error settings. These timings measure the Node search kernel workload. End-to-end browser latency includes asset loading and rendering.
