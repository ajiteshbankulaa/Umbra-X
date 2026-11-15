# AI System Architecture

**Status:** Phase 4 verified scientific AI architecture (`research/benchmarks/ai_eval_report.json`, `server/research.test.mjs`).

## 1. Governing Principle

Umbra-X separates **authoritative physical computation** from **language interpretation and synthesis**:

1. **Deterministic Physics & Provenance:** Every ephemeris vector, 48 km / 96 km horizon occultation angle, 2-sigma LOLA error perturbation, slope, battery mass balance, counterfactual recovery search, and SHA-256 checksum is computed exclusively by deterministic Rust/WASM, TypeScript, and Node modules (`web/src/planner/model.ts`, `web/src/planner/recoverySearch.ts`, `server/tools.mjs`).
2. **Constrained Orchestration:** The AI layer (`server/researchAgent.mjs`) interprets natural-language questions, calls strictly validated read-only tools, retrieves scientific passages from the local Qdrant + BM25 corpus (`server/rag.mjs`), verifies numerical and citation grounding (`verifyGroundedOutput`), and abstains when evidence is absent, out-of-coverage, contradictory, or unmodeled.
3. **Graceful Local Fallback:** When no external OpenAI-compatible provider is configured (`providerConfiguredEnv = false`), or when a hosted/local LLM endpoint fails with transient HTTP errors (`429/502/503/504`) or timeout, `/api/research/ask` executes `runLocalDeterministicWorkflow` against the same live tool suite without hallucinating or stalling.

## 2. System Dataflow

```
User / UI Query
      │
      ▼
POST /api/research/ask  (800-char limit, CORS origin check, 25s AbortSignal timeout)
      │
      ├──► ResponseLruCache (SHA-256 key over normalized query + context + solverVersion)
      │         └─ Hit -> Return cached grounded JSON with latencyMs
      │
      ▼
runConstrainedResearchAgent (server/researchAgent.mjs)
      │
      ├──► If UMBRA_MODEL_URL & UMBRA_MODEL configured:
      │      createOpenAiCompatibleProvider (HTTPS or loopback HTTP, retries <= 3)
      │      with TOOL_SCHEMAS (server/tools.mjs)
      │         └─ Any failure / hallucinated draft -> Safe fallback to local deterministic workflow
      │
      └──► Multi-step Tool Execution (createScientificToolbox):
             1. inspect_coverage       -> regional bounds, ephemeris window, SHA-256 hashes
             2. get_scenario / simulate_scenario -> physics metrics + confidence flags
             3. compare_scenarios      -> baseline vs revised deltas + failing constraints
             4. search_alternatives    -> Pareto recovery frontier (Rust/WASM or TS)
             5. inspect_terrain_sensitivity -> 48km vs 96km, 2-sigma, mast sweep (1.5..20m)
             6. get_decision_certificate -> reproducible decision fingerprint
             7. retrieve_scientific_evidence -> hybrid RRF search (server/rag.mjs)
                    │
                    ▼
             ResearchCorpusRetriever (Node <-> Python stdio RPC)
                    ├─ Primary: Qdrant (`BAAI/bge-small-en-v1.5`, 384-d) + BM25 RRF (`research/rag/retriever.py`)
                    └─ Fallback: In-process `JsBm25Fallback` (`research/rag/corpus_chunks.json`)
                    │
                    ▼
             verifyGroundedOutput
                    ├─ Numeric tolerance check (including unit conversions Wh<->kWh, deg<->rad)
                    ├─ Citation ID membership check against retrieved docId/passageId set
                    └─ Rejects ungrounded drafts; preserves raw tool trace + cited metadata
```

## 3. Server API & Preservation of Phase 1–3 Capabilities

`server/server.mjs` preserves all existing study planning endpoints (`GET /api/study/coverage`, `POST /api/study/interpret`, `POST /api/study/runs`, SQLite persistence in `server/state/studies.sqlite`) while adding:

| Endpoint | Purpose | Request Bound | Key Guarantees |
| :--- | :--- | :--- | :--- |
| `POST /api/research/evidence` | Hybrid scientific passage lookup | `query <= 500 chars`, `topK in 1..8` | Returns sanitized chunks, SHA-256 provenance, score breakdown, injection flags |
| `POST /api/research/ask` | Constrained scientific QA & tool synthesis | `question <= 800 chars`, `25 s` timeout | Returns `status` (`answered` / `abstain` / `clarify`), `toolTrace`, `citations`, `groundingCheck`, `providerMode`, `tokenUsage`, `estimatedCostUsd` |

## 4. Provider Security & Cost Accounting

Implemented in `server/providers.mjs` (`createOpenAiCompatibleProvider`):

- **Transport Hygiene:** Refuses non-HTTPS remote URLs (`http:` is allowed exclusively for loopback `localhost`, `127.0.0.1`, `[::1]`) and disables HTTP redirects (`redirect: 'error'`).
- **Determinism & Timeout:** Enforces `temperature: 0`, propagates `AbortSignal`, and caps retries (`UMBRA_MODEL_RETRIES <= 3`) with exponential backoff (`150 * 2^attempt` ms) strictly on retryable status codes (`429, 502, 503, 504`).
- **Telemetry:** Extracts `prompt_tokens` / `completion_tokens` and computes exact per-request estimated cost from `UMBRA_COST_INPUT_PER_M` and `UMBRA_COST_OUTPUT_PER_M`.
- **Caching:** `ResponseLruCache` keys entries by SHA-256 of `{ q, context, solverVersion }`, automatically invalidating stale cache entries whenever `web/src/planner/model.ts`, `server/study.mjs`, or `web/public/wasm/umbra_core.wasm` changes.
