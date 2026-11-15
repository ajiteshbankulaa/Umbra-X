# Retrieval Corpus & Evaluation

**Benchmark Artifact:** [`research/benchmarks/retrieval_eval.json`](../research/benchmarks/retrieval_eval.json)  
**Corpus Manifest & Ingest Report:** [`research/rag/sources_manifest.json`](../research/rag/sources_manifest.json), [`research/benchmarks/corpus_ingest_report.json`](../research/benchmarks/corpus_ingest_report.json)

## 1. Verified Scientific Corpus Composition

We replaced ad-hoc string snippets with a persistent, SHA-256 audited scientific corpus ingested by `research/rag/ingest_corpus.py`:

- **Total Authoritative Documents:** **17**
  - **7 Live NASA NTRS Citations (`ntrs_json`):** `20205009660` (Barker, Mazarico, Neumann et al. 2020/2021 — LOLA elevation error & south pole illumination), `20220018440` (Barker et al. 2022 — New LOLA topographic products), `20170007365` (Glaser et al. 2017/2018 — Illumination conditions at lunar poles), `20230016267` (Bleacher et al. 2023 — Lunar Site Selection), `20250011660` (George et al. 2025 — Artemis III downselection to 9 regions), `20080045536` (Lunar polar illumination & energy storage), `20110015800` (Mazarico et al. 2011 — LOLA polar illumination).
  - **3 Official NASA / JPL Reference Specifications (`html`):** NASA GSFC PGDA Product `90` (`https://pgda.gsfc.nasa.gov/products/90`), JPL DE440 & DE441 technical documentation, and JPL Horizons user manual.
  - **7 Local Verified Umbra-X Engineering Documents (`local_markdown`):** `SCIENTIFIC_METHOD.md`, `VALIDATION_MATRIX.md`, `UNCERTAINTY_AND_LIMITATIONS.md`, `DATA_PROVENANCE.md`, `MISSION_RECOVERY.md`, `OPTIMIZATION_OBJECTIVES.md`, and `DECISION_CERTIFICATE.md`.
- **Chunking Strategy:** Structure-aware `markdown_section_sliding_window` (`maxChars = 750`, `overlapChars = 120`), producing **169 indexed chunks**.
- **Dense Embeddings & Vector Database:** Embedded locally on CPU using FastEmbed **`BAAI/bge-small-en-v1.5`** (`dimension = 384`, `cosine` distance) and persisted in embedded **Qdrant** (`research/rag/qdrant_db`, collection `umbra_research_corpus`).
- **Measured Ingestion Cost (CPU):** Embedding `38,571.6 ms`, end-to-end ingestion total `52,628.3 ms`.

Every ingested passage carries `docId`, `passageId`, `title`, `sectionTitle`, `citation`, `sourceUrl`, `contentSha256`, and `retrievedAt` so downstream agents can trace claims back to exact immutable documents.

## 2. Quantitative Retrieval Benchmark (24 Domain Queries)

We evaluated four retrieval configurations on 24 curated lunar planning, geodesy, ephemeris, uncertainty, and DOI lookup queries (`research/rag/benchmark_queries.json`) using `research/rag/eval_retrieval.py`:

| Retrieval Mode | Recall@1 | Recall@3 | Recall@5 | MRR@5 | nDCG@5 | Warm p50 Latency | Warm p95 Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `tfidf_legacy` (lexical baseline) | 0.8333 | 0.9167 | 0.9583 | 0.8854 | 0.6129 | 0.53 ms | 1.59 ms |
| `bm25` (Okapi BM25) | 0.8333 | 0.9167 | 0.9583 | 0.8785 | 0.6193 | 0.77 ms | 0.97 ms |
| `dense_qdrant` (`bge-small-en-v1.5`) | 0.7917 | 0.9583 | 1.0000 | 0.8854 | 0.5917 | 20.83 ms | 29.59 ms |
| **`hybrid_rrf` (Dense Qdrant + BM25 RRF)** | **0.8750** | **1.0000** | **1.0000** | **0.9375** | **0.6336** | **20.73 ms** | **32.77 ms** |

## 3. Why Hybrid RRF Outperforms Both Standalone Modes

1. **Exact Technical Identifiers Hurt Dense-Only Retrieval:** On `q24` (`"Barker 2023 Planetary Science Journal DOI 10.3847/PSJ/acf3e1 PGDA product 90"`), `dense_qdrant` slipped `nasa-pgda-lola-spole` to rank 3 (R@1 miss) because subword embeddings dilute raw DOI strings, whereas BM25 exact token matching preserved it at rank 1.
2. **Conceptual Paraphrases Hurt Lexical-Only Retrieval:** On `q23` (`"Does azimuth step 0.25 degrees vs 1 degree or 1-minute vs 5-minute time step change blackout durations?"`) and `q04` (semantic paraphrase of distant crater shadows), `tfidf_legacy` and `bm25` missed `umbrax-validation-matrix` / `ntrs-glaser-2017` at rank 1 (and `q23` missed even top 5 under both lexical methods). Dense Qdrant recovered `1.0000` Recall@5 across all 24 queries.
3. **Reciprocal Rank Fusion Combines Both Strengths:** `hybrid_rrf` reached **100% Recall@3** and **0.9375 MRR@5** (+5.9% relative MRR over legacy TF-IDF) at **20.73 ms median latency** cleanly inside an interactive budget.

## 4. Documented Rank-1 Misses (Transparent Error Analysis)

`hybrid_rrf` still recorded **3 rank-1 misses** (all recovered cleanly at rank 2, hence `Recall@3 = 1.0000`):

- **`q07` (`ephemeris_paraphrase`):** Ranked `jpl-horizons-manual` #1 ahead of expected `umbrax-scientific-method` (#2) because general kernel/frame vocabulary appears heavily in the Horizons manual.
- **`q10` (`psr_science`):** Ranked `ntrs-barker-lola-2022` #1 ahead of `umbrax-uncertainty-limitations` (#2), as Barker (2022) abstract also discusses PSR LOLA mapping closely.
- **`q23` (`convergence_analysis`):** Ranked `umbrax-mission-recovery` #1 and expected `umbrax-uncertainty-limitations` #2 while missing `umbrax-validation-matrix` at rank 1.
