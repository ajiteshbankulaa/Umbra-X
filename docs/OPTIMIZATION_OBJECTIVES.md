# Multi-Objective Pareto Optimization & Robustness Ranking

Umbra-X refuses to hide engineering compromises behind an opaque "AI confidence score." Instead, Mission Recovery exposes a **7-objective non-dominated Pareto frontier** computed in `web/src/planner/recovery.ts::rankParetoRecoveryAlternatives`.

## 1. Decision Variables & Hard Feasibility Filter

For a fixed mast height (`mast`), search scope (`same-site`, `all-polar`, or explicit site list), and allowed delay window (`[minStart, maxStart]` in integer hours):
- **Fast Hard Filter (`collectPassingStartsByPad`)**: Evaluates `obs.slope <= limits.slope` followed by `wasm.searchDual` / `searchObserverDual`, enforcing **both `96 km` regional and `48 km` comparison horizons** simultaneously at the active sigma profile (`power.sigma`).
- **Full Physics & Energy Balance (`analyze`)**: Evaluates selected candidates spanning all extremity orders (nearest schedule/location, lowest darkness, lowest Earth blackout, flattest slope, highest solar percentage) for closed-loop PV generation, battery sizing (`batteryKg`, `unmetWh`, `headroomKg`), and 3-complex DSN visibility (`DSS-14`, `DSS-65`, `DSS-43`).

A candidate is marked `feasible = true` **if and only if**:
1. `complete === true` (`360/360` regional azimuth coverage)
2. `slope !== null && slope <= limits.slope`
3. `longestDark <= limits.dark` and `longestEarth <= limits.earth`
4. `unmetWh < 1e-6` and `batteryKg + hardwareKg <= budgetKg`

## 2. The 7 Pareto Objectives (All Minimized)

Each feasible candidate $c$ maps to a 7-tuple:
$$\mathbf{f}(c) = \big(\mathrm{longestDark}(c),\ \mathrm{longestEarth}(c),\ \mathrm{slope}(c),\ \mathrm{batteryKg}(c),\ \mathrm{displacementKm}(c),\ \mathrm{absScheduleShiftHours}(c),\ \mathrm{robustnessRank}(c)\big)$$

where:
- `longestDark` (`h`): Maximum continuous interval below `solarThreshold = 0.1`.
- `longestEarth` (`h`): Maximum continuous direct-to-Earth occultation interval (`earthMargin <= 0`).
- `slope` (`°`): Coarse `20 m/px` LOLA geodetic finite-difference surface slope.
- `batteryKg` (`kg`): Minimum battery mass needed (`usableWh / (specificWh * 0.8)`).
- `displacementKm` (`km`): Spherical great-circle distance from baseline pad coordinates ($R = 1,737.4\ \mathrm{km}$):
  $$d = 2 R \arcsin\!\sqrt{\sin^2(\Delta\phi/2) + \cos\phi_1\cos\phi_2\sin^2(\Delta\lambda/2)}.$$
- `absScheduleShiftHours` (`h`): $|t_{\mathrm{alt}} - t_{\mathrm{base}}|$.
- `robustnessRank`: Ordinal rank over executed checks (`0 = passes_all_tested`, `1 = nominal_only_sensitivity_fails`, `2 = unassessed_missing_data`, `3 = fails_constraints`).

Candidate $a$ dominates $b$ ($a \prec b$) iff $\forall i,\ f_i(a) \le f_i(b) + 10^{-6}$ and $\exists j,\ f_j(a) < f_j(b) - 10^{-6}$. Every non-dominated candidate remains in `paretoFrontier` simultaneously — e.g., tied flat-vs-dark-vs-nearby alternatives are preserved side-by-side (`14` frontier options evaluated in the `48..360 h` Shackleton `+48h` reference run).

## 3. Archetype Labels & Optional Weighted Tie-Breaking

For interpretability, `rankParetoRecoveryAlternatives` tags extrema on the frontier with explicit archetype labels:
- `Lowest Darkness` (`min longestDark`)
- `Lowest Earth Blackout` (`min longestEarth`)
- `Flattest Slope` (`min slope`)
- `Lowest Battery Mass` (`min batteryKg`)
- `Minimum Relocation` (`min displacementKm`)
- `Smallest Schedule Shift` (`min absScheduleShiftHours`)
- `Most Robust Tested` (`min robustnessRank`)

Optional user preference weights (`weights`) compute a min-max normalized weighted tie-breaker across `paretoFrontier` (`DEFAULT_OBJECTIVE_WEIGHTS`: `[1.0, 1.0, 0.8, 1.0, 0.6, 0.5, 1.2]`), ordered strictly after `robustnessRank` so robust candidates always outrank sensitivity-fragile candidates. Raw unscaled physical units are never replaced or hidden by scalar scores.

## 4. Bounded Near-Miss Fallback (`feasibleCount === 0`)

If zero candidates pass geometry and energy constraints, `recoverySearch.ts` runs a strided bounded near-miss scan (`nearMissPadStride = 16`, `nearMissHourStep = 24`) and scores failures by normalized overrun:
$$V(c) = \frac{\max(0, s - s_{\max})}{s_{\max}} + \frac{\max(0, d - d_{\max})}{\max(1, d_{\max})} + \frac{\max(0, e - e_{\max})}{\max(1, e_{\max})} + \frac{\max(0, m_{\mathrm{batt}} - m_{\mathrm{avail}})}{m_{\mathrm{avail}}} + \frac{\mathrm{unmetWh}}{\max(1, 12 P_{\mathrm{load}})} + 10 \cdot \mathbb{I}[\neg\mathrm{complete}].$$
Top near-misses are explicitly flagged `feasible: false` (`INFEASIBLE`) to diagnose which limits would need relaxation.

## 5. Robustness Classification State Machine (`classifyCandidateRobustness`)

| Classification | Exact Condition | Honest Scope Statement |
| --- | --- | --- |
| `unassessed_missing_data` | `< 360/360` covered azimuths, missing regional tables, or missing `horizonError` under `dual-extent-and-sigma` | Outage maxima are optimistic lower bounds |
| `fails_constraints` | Fails `96 km` nominal geometry or energy/mass balance (`feasible = false`) | Candidate violates baseline requirements |
| `nominal_only_sensitivity_fails` | Nominal `96 km` + power pass, yet `48 km` extent fails (under dual/sigma mode) or `max(2, sigma)` vertical error perturbation fails (under `dual-extent-and-sigma`) | Vulnerable to horizon model choice / LOLA elevation uncertainty |
| `passes_all_tested` | Passes `96 km` nominal geometry, energy/mass balance, `48 km` extent, and (when configured) `2-sigma` LOLA uncertainty | Stable **only across tested extents (`48/96 km`) and `2-sigma` LOLA error**, never global statistical certainty |
