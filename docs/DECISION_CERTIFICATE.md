# Mission Decision Certificate Specification (`umbra-x.decision-certificate/v2`)

Every Mission Recovery execution synthesizes an exportable, deterministically fingerprinted **Mission Decision Certificate** (`web/src/planner/recovery.ts::buildDecisionCertificate`), downloadable directly in the UI as `umbra-x-decision-certificate.json` or inspectable inline in the Decision tab.

## 1. Design Guarantee: Deterministic Reproducibility

To ensure independent auditing and regression comparison:
- **Zero wall-clock variance**: Certificates exclude wall-clock `Date.now()` timestamps (`generatedWithoutWallClockTimestamp: true`).
- **Canonical 128-bit Fingerprint (`deterministicFingerprint`)**: Computed by `canonicalFingerprint(corePayload)` via recursive sorted-key canonical JSON serialization with `1e-6` numeric stabilization and dual 64-bit FNV-1a accumulators (`fnv1a128:<32-hex>`).
- **WASM / TS Bit-Identity Verified**: `node web/src/planner/recovery-benchmark.mjs` verifies that `Rust/WASM` (`umbra_core.wasm`) and `Optimized TS` (`searchObserverDual`) produce identical certificates and an identical fingerprint for the Shackleton Ridge `+48h` reference problem.

## 2. Certificate Top-Level Schema

| Key | Purpose |
| --- | --- |
| `schema` | Fixed schema tag `'umbra-x.decision-certificate/v2'` |
| `calculationVersion` | Calculation version tag `'umbra-x-recovery-v2.1-dss63'` |
| `deterministicFingerprint` | Reproducible `fnv1a128:...` digest over entire core payload |
| `problem` | Full typed `MissionRecoveryProblem` input specification |
| `validation` | Structured validation outcome (`ok`, resolved `sites`, simulation `steps`) |
| `scientificDataProvenance` | Per-site `vectorHash`, `localHash`, regional radii (`48,000 m / 96,000 m`), frame (`MOON_ME_DE440_ME421`), DSN station mask, and upstream NAIF SPICE kernel URLs + SHA-256 digests |
| `ephemerisCoverage` | `startUtc` (`2026-11-14T00:00:00Z`), `stepMinutes` (`5`), `count` (`8,641`), `totalHours` (`720`), requested window start & length |
| `terrainCoverage` | `azimuthBins` (`360`), `nominalRadiusKm` (`96`), `comparisonRadiusKm` (`48`), `baselineComplete`, `revisedComplete` |
| `modelAssumptions` | `solarThreshold` (`0.1`), `arrayMode`, `nominalSigma`, `specificWh`, `hardwareKg`, `budgetKg`, and engineering `limits` |
| `counterfactualComparison` | Structured `CounterfactualDiff` (before/after checks, `firstViolatedConstraint`, improved/deteriorated/unchanged constraints, relative & absolute metric deltas) |
| `sensitivityResults` | Full `CandidateRobustness` traces (`assumptionsChecked[]`) for baseline, revised, and recommended candidates |
| `samePadRecovery` | Closest or passing schedule-shifted configuration on the revised pad |
| `paretoAlternatives` | Complete list of non-dominated 7-objective Pareto frontier options |
| `geometryOnlyPowerFailures` | Candidates passing geometric limits that failed electrical/battery sizing |
| `nearMisses` | Populated only when `feasibleCount === 0`; bounded infeasible near-misses |
| `knownLimitations` | Explicit `Not modeled` scientific boundaries preserved verbatim in every export |
| `causalConclusion` | Numerical `RecoveryExplanation` directly computed from active run outputs |
