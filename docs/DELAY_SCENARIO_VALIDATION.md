# Delayed landing scenario validation

The guided recovery search now restricts starts to 48–360 hours after the
2026-11-14 UTC catalog epoch, with a 15-day mission and 5 m mast. The reproducible
runner is `node web/src/planner/recovery-benchmark.mjs`.

The current run finds 33,619 geometry-passing pairs across `[48..360 h]`, evaluates a capped shortlist
of 64 candidates, and returns 14 non-dominated alternatives among those evaluated.
Pad 301 ranks first. Pad 479 remains a 280 m alternative. Counts refer to this
specific configuration and dataset, and must be regenerated after model changes.

Both WASM and TypeScript generated the same decision fingerprint in this run
(`fnv1a128:33c0caec6858f9c01ab631c2d3e95f74`). Across the full `[0..360 h]` window (`benchmark.mjs`), the bundle yields 61,824 passing pairs at `5.0 m / 0-sigma` and does not isolate post-delay starts.

## Pad 479 numerical comparison

Run `python pipeline/benchmark_convergence.py` to regenerate the source report in
`pipeline/benchmarks/convergence_benchmark.json`. Its `missionWindows` entries use
the exact 15-day, +48-hour scenario, with a 10% solar-disk low-light threshold. The benchmark uses the current apparent ephemeris, a fixed solar disk and no eclipse attenuation; the exact browser uses a distance-dependent disk and an eclipse model.

| Calculation | Longest low light | Longest Earth obstruction |
| --- | ---: | ---: |
| Compiled 96 km planner | 0 h | 4.833 h |
| Benchmark 96 km raymarch | 0 h | 4.917 h |
| Benchmark 144 km raymarch | 0 h | 17.583 h |
| Compiled 96 km with 2σ height perturbation | 0 h | 8.750 h |

The expanded horizon increases Earth obstruction while remaining below the
72-hour threshold. The benchmark and compiled 96 km results differ by one
five-minute sample for the longest Earth obstruction. These results are numerical
comparisons. The benchmark does not yet certify complete 144 km angular coverage
or attach an expanded-verification label to the app.

The slope comparison previously assumed a grid with start pixel 8 and step 8.
It now reads the release manifest's actual start pixel 23 and step 7. Pad 479
measures 0.9413° from the compiled slope, 0.9414° from the geodetic calculation,
and 0.9039° from the archived LOLA slope. Existing reports for off-center pads
that used the assumed grid require regeneration.
