# Counterfactual Mission Recovery (`web/src/planner/recovery.ts`, `recoverySearch.ts`)

Mission Recovery answers a concrete planning question: **when a landing schedule slips or engineering limits change, why did the revised plan fail or improve, can schedule shift recover the same pad, and what alternative pads/windows recover feasibility across verified NASA terrain and power sizing?**

Every computation executes over Umbra-X's compiled NASA LRO LOLA horizon datasets (`web/public/data/planner-release/`) and NAIF DE440 ephemeris (`vectors.bin`) through the Web Worker (`planner.worker.ts`) and shared offline runner (`recoverySearch.ts`).

## 1. Typed Problem Contract (`MissionRecoveryProblem`)

| Field | Type / Range | Units / Semantics |
| --- | --- | --- |
| `baseline`, `revised` | `{ site, node (0..960), start (h), mast (0..4) }` | Polar bundles (`shackleton-ridge`, `mons-mouton`, `malapert-massif`); mast indices map to `[1.5, 3, 5, 10, 20] m` |
| `days` | Integer `1..15` | Mission window length (`24..360 h`, `288..4,320` 5-min samples) |
| `limits` | `{ dark, earth, slope }` | Max low-light outage (`h`), max DTE Earth blackout (`h`), max 20 m slope (`°`) |
| `power` | `{ arrayW, loadW, specificWh, hardwareKg, budgetKg, arrayMode?, sigma? }` | Electrical & mass budget (`budgetKg > hardwareKg`) |
| `delayWindowHours` | `{ minStart, maxStart }` | Allowed start hours inside `[0, totalHours - days*24]` (`0..360 h` at `15 d`) |
| `scope` | `'same-site' \| 'all-polar' \| { kind: 'sites', sites }` | Spatial search scope (`2,883` pads across all 3 polar regions) |
| `robustnessPreference` | `'nominal-only' \| 'dual-extent-48-96km' \| 'dual-extent-and-sigma'` | Sensitivity checks enforced per candidate |

`validateRecoveryProblem` rejects unsupported ephemeris-only footprints (`apollo-11`, `custom`), window overruns past `720 h`, `days` outside `1..15`, non-positive `arrayW`/`loadW`/`specificWh`, and `budgetKg <= hardwareKg`.

## 2. Counterfactual Diff Engine (`computeCounterfactualDiff`)

Evaluates baseline and revised configurations through `model.ts::analyze()` and produces structured checks across:
1. `coverage` (`complete: true`, `360/360` covered azimuths)
2. `slope` (`<= limits.slope`)
3. `longestDark` (`<= limits.dark`)
4. `longestEarth` (`<= limits.earth`)
5. `powerUnmet` (`unmetWh < 1e-6`)
6. `batteryMass` (`batteryKg + hardwareKg <= budgetKg`)

Outputs explicitly separate **geometry feasibility** (`coverage` + `slope` + `longestDark` + `longestEarth`) from **power/storage feasibility** (`powerUnmet` + `batteryMass`):
- `all_satisfied`: Passes all geometric, coverage, and mass constraints.
- `geometry_only_power_fails`: Geometry passes, yet energy storage mass exceeds usable budget / leaves `unmetWh > 0`.
- `partial_improvement_still_infeasible`: One or more constraints improved relative to baseline, yet at least one constraint remains violated.
- `insufficient_coverage`: Partial regional horizon (`< 360` azimuths); bounds are unverified.
- `infeasible`: Fails without margin improvements.

## 3. Verified Demonstrations (`node web/src/planner/recovery-benchmark.mjs`)

### A. Defining Demonstration: Shackleton Ridge Pad 481, +48h Delay (`15 d`, `5 m` mast)
- **Baseline (`pad 481 @ T+0h`)**: `longestDark = 52.25 h` (`52.3 h`), `longestEarth = 103.67 h` (`103.7 h`), `slope = 5.60°`, `batteryKg = 56.88 kg` (`56.9 kg`, `feasible = false`).
- **Revised (`pad 481 @ T+48h`)**:
  - **Improved**: Earth blackout drops `-48.00 h` (`103.67 h -> 55.67 h`), now passing `<= 72 h`.
  - **Still failing**: `longestDark = 52.25 h` (`> 48 h` limit) and `slope = 5.60°` (`> 5°` limit).
- **Same-pad scan (`pad 481`, `48..360 h`)**: No start hour recovers `pad 481` because `5.60°` terrain slope fails at all start times.
- **Regional Pareto Recovery (`2,883` pads × `48..360 h` starts)**: Finds `33,619` passing `(pad, start)` pairs across all 3 polar regions (and `61,824` pairs across full `0..360 h` in `benchmark.mjs`), evaluates the capped shortlist (`64` power+geometry feasible candidates), and surfaces **`14` non-dominated Pareto alternatives**, led by **`shackleton-ridge pad 301 @ T+48h`** (`0 h` low light, `0 h` Earth blackout, `1.62°` slope, `0 kg` battery, `80.00 kg` headroom, `passes_all_tested`) alongside nearby **`shackleton-ridge pad 479 @ T+48h`** (`0.28 km` away, `0 h` low light, `4.83 h` Earth blackout, `0.94°` slope, `0 kg` battery, `80.00 kg` headroom, `passes_all_tested`).

### B. Geometry-Passing / Power-Failing Case: Shackleton Pad 217 @ T+48h
- Limits relaxed to `dark <= 100 h, earth <= 72 h, slope <= 5°` (`100 kg` total budget, `20 kg` fixed hardware -> `80 kg` usable battery allowance).
- `pad 217 @ T+48h` passes geometry (`91.00 h <= 100 h` dark, `< 72 h` Earth, `< 5°` slope), yet requires `96.07 kg` battery and suffers `1,832.26 Wh` unmet load -> flagged **`geometry_only_power_fails`** (`firstViolatedConstraint: 'powerUnmet'`). Recovery selects `pad 301 @ T+48h` (`0 kg` battery).

### C. Zero-Feasible Stress Test (`dark=0, earth=0, slope=0, budget=21 kg`)
- Returns `feasibleCount = 0`, `paretoFrontier = []`, `recommended = null`, and surfaces bounded near-misses (`pad 181 @ 48h`, `pad 417 @ 48h/72h`) explicitly tagged `feasible: false` (`INFEASIBLE` in the UI).

### D. Sensitivity Flip Case: Mons Mouton Pad 17 @ T+67h (`dark <= 48.7 h`, `budget = 140 kg`)
- Passes `96 km` nominal (`48.58 h <= 48.7 h`), passes `48 km` extent (`48.58 h`), and passes energy balance (`power_balance: true`), yet **fails `2-sigma` LOLA height perturbation**, classifying cleanly as **`nominal_only_sensitivity_fails`**.

## 4. Measured Execution Performance

Executed on `2,883` regional polar pads (`8,641` DE440 steps) via `node web/src/planner/recovery-benchmark.mjs` and `node web/src/planner/benchmark.mjs`:
- **WASM kernel (`umbra_core.wasm`)**: `50,415 bytes` raw (`19,429 bytes` gzipped).
- **Full recovery benchmark (`recovery-benchmark.mjs`, including SHA-256 bundle load + 3-region search + certificate generation)**: `23,842 ms` cold (`WASM` + disk/SHA-256 load), `[14,238 ms, 7,786 ms]` warm (`WASM`), vs `7,199 ms` (`Optimized TS`, bit-identical `fnv1a128:67097cdf27ade73b81ce7ccee73370aa` Decision Certificate fingerprint).
- **Pure 3-region search kernel (`benchmark.mjs`, `3 × 961` pads × `361` starts, `mast=5.0m`, `sigma=0`, `61,824` pairs)**: `Rust/WASM` (`3,994.3 ms` cold / `1,559.2 ms` warm p50 / `2,529.2 ms` warm p95) and **`WASM SitePack`** (`2,397.3 ms` cold / `1,311.0 ms` warm p50 / `1,855.5 ms` warm p95 — **`5.17×` vs Baseline TS**, **`1.80×` vs Optimized TS**).
