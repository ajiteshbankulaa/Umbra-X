# Inference & Serving Performance Benchmarks

**Benchmark Artifacts:** [`research/benchmarks/inference_python.json`](../research/benchmarks/inference_python.json), [`research/benchmarks/serving_node.json`](../research/benchmarks/serving_node.json)  
**Reproducible Scripts:** [`research/inference/benchmark_inference.py`](../research/inference/benchmark_inference.py), [`server/benchmark_serving.mjs`](../server/benchmark_serving.mjs)

## 1. Execution Environment Disclosure

All benchmarks ran locally on **CPU** (`12` logical cores, Node.js `v24.11.0`, PyTorch `2.15.0+cpu`, `fastembed-onnxruntime-cpu`):

- `cudaAvailableInVenv = false` in Python `.venv` (CPU-only PyTorch and ONNX Runtime wheels). No GPU execution numbers are synthesized or claimed.

## 2. Python Embedding, Qdrant Vector Search & ML Surrogate Inference (CPU)

### 2.1 FastEmbed (`BAAI/bge-small-en-v1.5`, ONNXRuntime CPU)

| Workload | Cold Latency | Warm p50 | Warm p95 | Throughput (chunks/s) |
| :--- | :---: | :---: | :---: | :---: |
| Model initialization (`TextEmbedding`) | 450.54 ms | — | — | — |
| Single query embed (`batch = 1`) | 14.60 ms | 8.321 ms | 11.379 ms | 37.99 (`batch_1` passage mean `26.32 ms`) |
| Passage batch `batch = 8` | — | — | — | 16.34 (`61.20 ms/chunk`) |
| Passage batch `batch = 32` | — | — | — | 9.23 (`108.30 ms/chunk`) |
| Passage batch `batch = 64` | — | — | — | 3.15 (`317.22 ms/chunk`) |

**Observed Bottleneck (Length Padding + CPU Thread Contention):** On CPU ONNX Runtime, larger passage batch sizes (`8 -> 64`) degraded per-chunk throughput from `37.99` to `3.15 chunks/s` because dynamic zero-padding stretches every sequence in the batch to the longest chunk token length (`<= 750 chars`) and overflows L2/L3 cache across attention matrices. Length-bucketing or small micro-batches (`<= 8`) is preferable for CPU corpus re-indexing (`52.6 s` total for `169` chunks).

### 2.2 Qdrant + BM25 Hybrid Retrieval (Embedded Local Store, 169 Chunks)

Cold retriever initialization (`HybridResearchRetriever`) took `677.37 ms` (in Python). Warm query latencies across `25` queries:

| Mode | Warm p50 (ms) | Warm p95 (ms) | Mean (ms) | Mean QPS |
| :--- | :---: | :---: | :---: | :---: |
| `bm25` (in-memory sparse) | 0.460 | 1.027 | 0.513 | 1950.9 |
| `dense_qdrant` (`384-d cosine`) | 14.868 | 22.463 | 14.935 | 66.96 |
| `hybrid_rrf` (`Qdrant + BM25 RRF`) | 13.117 | 18.671 | 14.132 | 70.76 |

### 2.3 ML Surrogate CPU Inference (`PyTorch` 4 Threads vs `scikit-learn HistGBDT`)

| Batch Size | Model | p50 (ms) | p95 (ms) | Throughput (samples/s) |
| :---: | :--- | :---: | :---: | :---: |
| **1** | `HistGBDT` (cls + reg pair) | 7.522 | 11.730 | 131.1 |
| **1** | `PyTorch ResMLP` (single pass) | **0.305** | **0.748** | **3,276.0** |
| **1** | `PyTorch ResMLP` (16-pass MC Dropout) | 6.838 | 14.524 | 143.0 |
| **100** | `HistGBDT` (cls + reg pair) | 23.264 | 76.346 | 4,262.3 |
| **100** | `PyTorch ResMLP` (single pass) | **0.908** | **2.525** | **108,819.8** |
| **100** | `PyTorch ResMLP` (16-pass MC Dropout) | 20.783 | 47.681 | 4,792.6 |
| **961** *(1 full region grid)* | `HistGBDT` (cls + reg pair) | 13.850 | 22.878 | 69,385.3 |
| **961** *(1 full region grid)* | `PyTorch ResMLP` (single pass) | **1.591** | **3.298** | **602,999.3** |
| **961** *(1 full region grid)* | `PyTorch ResMLP` (16-pass MC Dropout) | 89.484 | 116.978 | 10,641.9 |

**Exact Physics vs Surrogate Pre-Screen Tradeoff:** Running exact JS dual-sigma (`0σ + 2σ`) simulation across 1 full `961`-pad grid for 1 start window takes **`18,985.27 ms` (`50.6 pads/s`)**, vs **`13.85 ms`** for `HistGBDT` (`1,370x` faster) or **`1.59 ms`** for `PyTorch ResMLP` (`~11,933x` faster) once static terrain summaries are precomputed.

## 3. Node.js Server Orchestration, Caching, Fault Recovery & Cost

| Component / Path | Cold (ms) | Warm p50 (ms) | Warm p95 (ms) | Notes |
| :--- | :---: | :---: | :---: | :--- |
| Exact `0σ + 2σ` dual physics (1 pad, 15 d, JS) | — | 10.146 | 15.577 | Core deterministic `analyze()` baseline |
| Node <-> Python Qdrant stdio bridge (uncached) | 2,733.51 | 11.209 | 18.452 | First call pays Python/Qdrant spawn once |
| `ResearchCorpusRetriever` in-memory cache hit | — | 0.003 | 0.042 | Normalized `mode|topK|query` key |
| Tool: `get_scenario` | 214.94 | 13.493 | 33.245 | Includes bundle hash check on cold call |
| Tool: `compare_scenarios` | 120.25 | 24.933 | 52.123 | Paired baseline vs delayed scenario |
| Tool: `inspect_terrain_sensitivity` | 72.26 | 77.078 | 86.874 | Evaluates `0σ`, `2σ`, `48/96 km`, `5` masts |
| Tool: `search_alternatives` (3-site Pareto recovery) | 7,807.60 | 7,554.602 | 7,821.695 | Heavy multi-region counterfactual sweep |
| Agent cold compare + certificate vs `ResponseLruCache` hit | 7,595.95 | **0.009** | **0.020** | **`~844,000x` speedup** on repeated study query |
| Concurrent burst (`12` mixed requests, `3` cache hits) | — | — | — | `16,460.51 ms` total (**`0.73 req/s`**; CPU-bound by uncached multi-site search tools) |

## 4. Transient Outage Recovery & Token/USD Cost Model

Evaluated via `runConstrainedResearchAgent` against a loopback OpenAI-compatible mock server (`gpt-4o-mini` reference pricing: `\$0.15 / 1M` input tokens, `\$0.60 / 1M` output tokens) injected with **2 consecutive HTTP `503` responses** before succeeding across a 2-turn tool loop:

- **HTTP Transactions Attempted:** `4` (`2` rejected `503` attempts with `150 ms + 300 ms` exponential backoff, `1` tool-call turn, `1` grounded JSON answer turn).
- **End-to-End Recovered Elapsed Time:** `537.14 ms` (`status: answered`, `groundingPassed: true`).
- **Observed Token Usage:** `1,100` prompt tokens + `83` completion tokens = `1,183` total tokens.
- **Estimated Marginal Provider Cost:** `\$0.000215` per two-turn tool-calling query (`\$0.215` per 1,000 uncached queries; `\$0.00` when resolved via `ResponseLruCache` or `runLocalDeterministicWorkflow`).
