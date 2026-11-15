# Umbra-X Performance & Scalability Benchmarks

All metrics below are directly measured on local hardware and saved in [`research/benchmarks/`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks). No numbers are extrapolated across hardware tiers.

## 1. Reference Benchmark Environment

Recorded in [`research/benchmarks/phase5_perf_report.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/phase5_perf_report.json) and [`research/benchmarks/inference_python.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/inference_python.json):
- **OS & Arch:** Windows (`win32` `x64`)
- **CPU & Memory:** Intel Core i7-1355U (`12` logical cores), `31.72 GB` system RAM
- **Node Runtime:** `v24.11.0`
- **Python ML/RAG Runtime:** CPU-only (`torch 2.15.0+cpu`, `fastembed-onnxruntime-cpu`; `cudaAvailableInVenv: false`)

---

## 2. Dataset Cold Load & SHA-256 Verification

Measured across all 3 south-polar `planner-release` site bundles (`node server/benchmark_phase5.mjs`):

| Region | Cold Read + SHA-256 Verify | Decoded Typed Arrays |
| :--- | ---: | ---: |
| `shackleton-ridge` | `59.53 ms` | `29.15 MB` |
| `mons-mouton` | `57.28 ms` | `29.15 MB` |
| `malapert-massif` | `56.30 ms` | `29.15 MB` |
| **All 3 Sites Sequential Total** | **`173.41 ms`** | **`~87.45 MB` arrays (`217.6 MB` process RSS)** |

---

## 3. Rust/WASM (`umbra_core.wasm`) vs Optimized TypeScript Kernel

Workload: `shackleton-ridge` 961-pad scan (`101` slope `<= 5°` eligible pads evaluated), `umbra_core.wasm` (`50,415` bytes raw, `19,429` bytes gzipped; prior Phase 5 benchmark `phase5_perf_report.json` recorded `45,051` B at `8.83 ms` cold instantiation):

| Engine | Full Sweep Latency | Per-Eligible-Pad `p50` | Per-Eligible-Pad `p95` | Throughput | Speedup vs TS |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Optimized TypeScript (`searchObserverDual`) | `229.43 ms` | `1.855 ms` | `3.751 ms` | `440.2 pads/s` | `1.00x` |
| Rust/WASM (`umbra_core.wasm`, Phase 5 per-pad `phase5_perf_report.json`) | `217.06 ms` | `1.821 ms` | `3.310 ms` | `465.3 pads/s` | **`1.06x`** |
| **Rust/WASM `SitePack` (`benchmark.mjs`, all 3 sites / 61,824 pairs)** | **`1,311.0 ms`** *(warm p50)* | — | — | — | **`1.80x` vs Opt TS / `5.17x` vs Base** |

> [!NOTE]
> **Recent `WASM SitePack` Improvement (`benchmark.mjs` vs earlier `phase5_perf_report.json`):** In the Phase 5 `101`-pad single-site `shackleton-ridge` microbenchmark (`phase5_perf_report.json`), per-pad copies yielded `1.06×` sweep speedup (`217.06 ms` vs `229.43 ms`), with `13–24%` tighter tail latency (`p95`: `3.310 ms` vs `3.751 ms`). Pre-uploading an entire site's horizon table once into WASM linear memory (`WASM SitePack`, `searchSiteDual`) cuts the full 3-region `361`-start (`61,824` pair) sweep to **`1,311.0 ms` warm p50** (`1,855.5 ms` warm p95) — **`1.80×` faster than Optimized TS (`2,363.3 ms`) and `5.17×` faster than Baseline TS (`6,779.4 ms`)** with 100% bit-level parity.

---

## 4. Queue & Worker Concurrency Sweep (`c = 1 .. 16`)

Measured against live `createUmbraServer` + SQLite WAL queue + isolated `worker_threads` study jobs (`phase5_perf_report.json`):

| Concurrent Jobs (`c`) | Active Workers | Total Wall Time | Throughput | Submit `p50 / p95` | Worker Exec `p50 / p95` | End-to-End `p50 / p95` |
| :---: | :---: | ---: | ---: | ---: | ---: | ---: |
| `1` | `1` | `561.77 ms` | `1.78 jobs/s` | `50.54 / 50.54 ms` | `303.33 / 303.33 ms` | `561.57 / 561.57 ms` |
| `2` | `1` | `1,079.97 ms` | `1.85 jobs/s` | `11.66 / 11.96 ms` | `382.92 / 408.99 ms` | `687.30 / 1,079.08 ms` |
| `4` | `1` | `2,988.72 ms` | `1.34 jobs/s` | `54.17 / 54.90 ms` | `632.08 / 767.76 ms` | `1,717.16 / 2,983.50 ms` |
| `8` | `2` | `4,109.60 ms` | `1.95 jobs/s` | `81.71 / 83.58 ms` | `948.11 / 998.66 ms` | `2,086.01 / 4,101.34 ms` |
| `16` | `2` | `6,622.95 ms` | **`2.42 jobs/s`** | `165.32 / 179.89 ms` | `730.88 / 945.27 ms` | `3,590.57 / 6,610.67 ms` |

- **Peak Memory Across Full Suite:** `308.07 MB` RSS (`89.71 MB` V8 heap total, `30.87 MB` heap used, `98.78 MB` external buffers).
- **Bottleneck Identified:** Each queued job currently spawns a fresh `worker_threads` child in [`server/worker.mjs`](file:///c:/Users/ajite/Desktop/UmbraX/server/worker.mjs) that re-reads and verifies site binary files (`303–948 ms` per job execution). Scaling from 1 to 2 polling worker loops lifts throughput from `1.34` (`c=4`) to `2.42 jobs/s` (`c=16`), validating multi-replica worker separation in Docker Compose. Keeping a warm pre-loaded dataset cache inside a persistent worker thread pool would eliminate per-job reload overhead in future work.

---

## 5. Retrieval, AI Co-Pilot & Surrogate Screening Latency (Phase 4 Context)

Measured in [`retrieval_eval.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/retrieval_eval.json), [`ai_eval_report.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/ai_eval_report.json), [`inference_python.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/inference_python.json), and [`serving_node.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/serving_node.json):

| Workload | Quality / Accuracy | Latency (`p50 / p95`) | Cache / Cost |
| :--- | :--- | :--- | :--- |
| Hybrid RRF RAG (`BAAI/bge-small-en-v1.5` + Qdrant + BM25, 169 chunks, 24 queries) | `R@1=0.875`, `R@3=1.000`, `R@5=1.000`, `MRR@5=0.9375` | `14.57 ms / 24.77 ms` (`2.73 s` cold Python bridge) | RAG cache hit: `0.003 ms` `p50` |
| Constrained Research Agent (`phase4_constrained_agent`, 28 eval cases) | `28/28 (100%)`, `0%` unsupported claims, `100%` abstention | `12.07 ms / 8,315.49 ms` (tool search tail) | Response LRU hit: `0.009 ms` `p50`; ~`\$0.215 / 1k` queries (`1,183` tok) |
| Node Physics Grid Dual (`961` pads, `0σ` + `2σ`) | Exact deterministic reference | `18,985.27 ms` (`50.6 pads/s`) | Zero ML error risk |
| CPU Surrogate Screening (`pytorch_res_mlp` / `hist_gbdt`, `batch_100`) | Top-10% candidate recall `1.000` (spatial holdout `ml_surrogate_report.json`) | `pytorch_res_mlp` single-pass `0.91 ms` (`108,820/s`); `hist_gbdt` `23.26 ms` | **Advisory screening pre-filter only** (physics verifies survivors) |
