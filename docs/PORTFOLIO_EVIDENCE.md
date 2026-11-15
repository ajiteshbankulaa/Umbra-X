# Umbra-X Portfolio & Systems Engineering Evidence

This index summarizes the verified technical contributions, architecture trade-offs, deployment runbooks, and empirical benchmarks across Phases 1–5 of Umbra-X.

---

## 1. Key Engineering Trade-Offs & Empirical Lessons

1. **Client-Side Physics vs Cloud Microservices:** Putting lunar horizon intersection, DE440 vector evaluation, and Pareto counterfactual recovery inside a browser Web Worker + `50 KB` Rust/WASM module eliminates ongoing server compute for public users. Only durable batch sweeps, RAG retrieval, live `80 m` terrain (`terrain_server.py`), and optional LLM synthesis live on the API/worker tier.
2. **Rust/WASM `SitePack` Batch Marshaling vs V8 JIT Honesty:** Benchmarking `umbra_core.wasm` against optimized TypeScript across all 3 polar regions (`benchmark.mjs`, `3 × 961` pads × `361` starts) shows per-pad copy Rust/WASM runs `1,559.2 ms` warm p50 (`1.52×` vs Opt TS, `4.35×` vs Baseline TS; earlier single-site `101`-pad sweep `phase5_perf_report.json` showed `1.06×`), whereas **pre-uploading a site's horizon table once into WASM linear memory (`WASM SitePack`, `searchSiteDual`) cuts warm p50 to `1,311.0 ms` (`1.80×` vs Opt TS, `5.17×` vs Baseline TS)** with 100% bit-level decision parity. Retaining both engines delivers cross-runtime verification and tighter tail latency (`1,855.5 ms` vs `3,866.7 ms` `p95`).
3. **Deterministic Tools Over Unconstrained LLM/RAG:** Across the 28-case evaluation ([`ai_eval_report.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/ai_eval_report.json)), `retrieval_only_rag` scored `21.4%` (`6.7%` abstention accuracy) and `legacy_deterministic` scored `50.0%` (`61.5%` false refusal rate), whereas `phase4_constrained_agent` passed `28/28 (100%)` with `0%` unsupported numeric claims.
4. **Classical Geometry Beats ML Surrogates for Final Safety:** Spatial block holdout training ([`ml_surrogate_report.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/ml_surrogate_report.json)) showed `pytorch_res_mlp` achieves `1.000` top-10% candidate recall at `0.91 ms / 100` samples (`batch_100`), making it effective as an *advisory pre-filter*, while `~27–29 h` regression MAE prohibits replacing deterministic physics (`REDUCE`/`recover`) for final pass/fail gating.
5. **Durable Queue Worker Isolation:** Separating `api` and `worker` with `node:sqlite` WAL leases (`BEGIN IMMEDIATE`), atomic temp writes + SHA-256 verification, and 2 worker replicas lifts `c=4..16` batch throughput from `1.34` to `2.42 jobs/s` ([`phase5_perf_report.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/phase5_perf_report.json)).

---

## 2. NASA Data Provenance & Release Verification

- **Upstream Sources:** NASA GSFC PGDA `LOLA_20mpp` / `80mpp` south-polar elevation, height sigma (`ERR`), archived slope (`LDSM`), and mapped `PSR` GeoTIFFs; JPL NAIF `de440s.bsp`, `moon_de440_250416.tf`, `moon_pa_de440_200625.bpc`, `pck00011.tpc` (`MOON_ME_DE440_ME421` frame); cross-checked vs JPL Horizons `AIRLESS` apparent (LT+S) topocentric angles (`<= 0.000001°` Sun, `<= 0.000025°` Earth across 15 withheld/control targets × 6 epochs).
- **Content-Addressed Fingerprint ([`infra/scripts/verify_release_integrity.mjs`](file:///c:/Users/ajite/Desktop/UmbraX/infra/scripts/verify_release_integrity.mjs)):**
  - Composite `releaseFingerprint`: `026908a9918134a256f46f173ab6aa5d949104c3548b123c9a20f69ec88d6b78`
  - Shared DE440 ephemeris: `b7ca9394446e781b5eaab0308b6e4ca58f471a41ac3eb115dc5e314926238321` (`829,536` bytes)
  - Rust/WASM kernel (`umbra_core.wasm`): `5643965ede531890ab363f74e381d717e691b8e6b3b2f62a8c8b6fb1016a9351` (`50,415` bytes)
  - Rollback: Revert static bucket/`web/dist` pointer and re-verify `releaseFingerprint` via `verify_release_integrity.mjs`; immutable `<sha256>.bin` assets coexist safely with revalidated `.json` manifests (`max-age=60, must-revalidate`).

---

## 3. Reproducible Deployment & Verification Runbook

### Local Full-Stack Container Topology (`infra/docker-compose.yml`)
Compose config validation passes (`docker compose --env-file infra/.env.example -f infra/docker-compose.yml config -q`). On a host with Docker Engine running:
1. `Copy-Item infra/.env.example infra/.env` and set a `>= 24`-char `UMBRA_API_TOKEN`.
2. `docker compose --env-file infra/.env -f infra/docker-compose.yml up --build`
3. Access Web (`:8080`), API health/metrics (`:8787/healthz`, `/readyz`, `/metrics`), Prometheus (`:9090`), and Grafana (`:3000`, provisioned dashboard `infra/observability/grafana/dashboards/umbrax-overview.json`).
*(Note: `docker build` was not executed on the Windows development host because Docker Desktop Linux Engine daemon was offline.)*

### Container & Deployment Stack (`infra/docker-compose.yml`)
- **Docker Compose Local Production Stack (`infra/docker-compose.yml`):** Orchestrates Nginx static web (`web`), non-root Node API (`api`), replicated background workers (`worker`, `replicas: 2`), distroless non-root live 80 m LOLA terrain sidecar (`terrain`, `pipeline/terrain_server.py` on `:8788`), SQLite WAL state (`umbra-state`), `Prometheus`, and `Grafana`. Compose configuration verified cleanly via `docker compose -f infra/docker-compose.yml config -q`.
- **Single-Node Queue Pragmatism:** Uses built-in `node:sqlite` WAL (`StudyQueueStore`) inside `umbra-state` to avoid unnecessary external DB dependencies while supporting atomic leases, dead-lettering, idempotency conflict detection (`HTTP 409`), and SHA-256 artifact integrity.

---

## 4. Verified Engineering Résumé Statements (Strict Grounding)

- **Geodesy & Ephemeris Verification:** *Compiled hybrid `20 m + 80 m` LRO LOLA (`96 km`) horizons and 5-minute JPL DE440 apparent (LT+S) ephemerides for `2,883` south-polar candidate pads; verified `<= 0.000001°` Sun and `<= 0.000025°` Earth alignment against JPL Horizons across 15 withheld/control targets.*
- **Browser/WASM Systems:** *Engineered a zero-backend Web Worker mission-recovery engine with a `50 KB` Rust/WASM kernel (`umbra_core.wasm`, `SitePack` batching `5.17×` vs baseline TS / `1.80×` vs Opt TS) and bit-identical TypeScript fallback, delivering SHA-256 content-addressed binary verification (`173.41 ms` total across 3 regions).*
- **Verifiable Scientific RAG & Agent Evaluation:** *Built a hybrid BM25 + dense `BAAI/bge-small-en-v1.5`/Qdrant RRF retriever (`MRR@5 = 0.9375`, `R@5 = 1.000`, `14.57 ms` `p50`) and schema-enforced tool agent (`28/28` eval pass rate vs `21.4%` retrieval-only baseline, `0%` unsupported numeric claims).*
- **Reliable Queue & Security Engineering:** *Architected a decoupled Node API and worker pipeline using SQLite WAL leases, idempotency conflict detection (`HTTP 409`), atomic temp-write + SHA-256 artifact verification, Prometheus/OTLP observability, constant-time Bearer auth, and `0`-advisory `npm audit` dependencies.*
