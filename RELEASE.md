# Umbra-X release evidence

## Decision walkthrough

Open the default 15-day Shackleton comparison. A delay from 14 to 16 November 2026 reduces the longest in-window Earth-center obstruction from 103.7 to 55.7 hours at pad 481, crossing the 72-hour limit. The 52.75-hour low-light interval still exceeds the 48-hour limit, and the pad exceeds the 5-degree slope limit. Inspect the obstruction, then compare the delayed start at pad 181. The corrected terrain model gives 0 hours of low light, 0 hours of Earth-center obstruction, and 4.54 degrees of coarse slope at pad 181. Battery estimates use the shared example load and ideal tracked solar array.

The app's **Reproduce a decision** section has three version-pinned links. Pad 217 is the trade-off case. It improves Earth-center visibility while raising required storage mass from 57.1 to 96.1 kg. The zero-outage, zero-slope case is a deliberately strict stress test with zero eligible pairs in the searched domain.

## Validation

At 5 m mast height and 15 days, the three-region search changed from 61,971 to 61,802 eligible pad/start pairs. All 169 removals occurred at Mons Mouton. At pad 17, 16 November 19:00 UTC, adding samples beyond the fine tile boundary increased the longest low-light interval from 45.08 to 48.67 hours. The exact default Shackleton comparison stayed unchanged. The before/after comparison holds the data epoch, limits, mast and time grid constant.

The pinned Horizons reference contains hourly subsets at the three original site centers. The maximum direction component difference was 0.00598 degrees there. The exact demo pad/start pairs were compared against one-minute DE440 samples using the same corrected terrain model. The largest crossing shift was four minutes. Exact-pad Horizons validation and independent terrain observations remain open.

- Geometry data and thresholds: web/public/release-evidence.json
- Sampling benchmark: web/public/release-timing.json
- NASA data: LRO LOLA PGDA, JPL DE440/NAIF and Horizons observer tables.
- Credit: see PLANNER.md and in-app Methods. This revision used OpenAI Codex for implementation and verification.
- Co-Pilot uses local keyword and sparse-vector retrieval with deterministic scenario answers. The portfolio system consists of the compiled geospatial dataset, versioned browser worker, Rust/WASM search, and the TypeScript fallback. The current index runs in memory and uses no managed vector service.

## Participant protocol

Results: pending, zero participants observed. Recruit five consenting participants, including one technical reviewer. Without coaching, ask each to compare the 48-hour slip, identify the changed constraint, and explain Earth-center visibility. Record participant number, role, seconds, completion, explanation, and one point of friction. The target is four of five succeeding within two minutes. Fix the most frequent issue and rerun the affected task.

Ask the technical reviewer to reproduce one export using the recorded source products and settings. Have them separately solve the comparable question with source tools. Record tool names, steps, elapsed time, assumptions, and which outputs can be compared. Record actual results after the sessions.

## Deploy the frozen build

Unzip the release and serve the contents at an HTTPS site root. Keep the data and wasm directories adjacent to index.html. For local review, serve the same files at localhost. Verify the public URL from a fresh private browser on desktop and mobile, click each replay link, switch to the 2D chart and inspect the timeline. Publish the captioned demo separately from the app host.

## Corrected search benchmark

Measured on Windows with an Intel Core i7-1355U and Node 24.11.0. The workload covers three regions, 961 pads each, 48 km and 96 km horizons, and 361 possible hourly starts for a 15-day mission. Seven runs per implementation include one cold and six warm runs.

| Search engine | Cold | Warm median | Warm p95 |
|---|---:|---:|---:|
| Reference TypeScript | 5.63 s | 6.08 s | 8.51 s |
| Optimized TypeScript | 2.21 s | 2.66 s | 4.12 s |
| Rust/WASM | 1.63 s | 2.40 s | 3.16 s |

Exact search decisions matched for the six exercised mast and local-error settings. These timings measure the Node search kernel workload. End-to-end browser latency includes asset loading and rendering.
