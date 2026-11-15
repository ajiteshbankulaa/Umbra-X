# Agent Safety, Tool Contracts, and Grounding Evaluation

**Evaluation Artifact:** [`research/benchmarks/ai_eval_report.json`](../research/benchmarks/ai_eval_report.json)  
**Test Suite:** [`server/research.test.mjs`](../server/research.test.mjs) (`node --test server/agent.test.mjs server/research.test.mjs` -> `9/9 pass`)

## 1. Strict Scientific Tool Contracts (`server/tools.mjs`)

All 8 registered tools validate inputs with `assertObjectKeys` (rejecting unknown arguments and out-of-range indices via `validatePlan` / `validateLimits` / `validateDays`) and stamp outputs with `calculationVersion`, `coverageStatus`, and `dataProvenance`:

| Tool | Inputs Enforced | Authoritative Responsibility |
| :--- | :--- | :--- |
| `inspect_coverage` | No parameters (`additionalProperties: false`) | Regions (`shackleton-ridge`, `mons-mouton`, `malapert-massif`), `720 h` DE440 epoch, mast heights `[1.5, 3, 5, 10, 20]` m, release SHA-256 |
| `get_scenario` | `site`, `node` (`0..960`), `start`, `mast` (`0..4`), `days` (`1..15`) | Single-pad orbital/terrain metrics, power mass, and confidence badges |
| `simulate_scenario` | Adds bounded `sigma` (`0..3`), `budgetKg`, `limits` | Full 48 km vs 96 km comparison and height uncertainty stress simulation |
| `compare_scenarios` | Validated `baseline`, `revised`, `days`, `limits` | Paired deltas (`longestDark`, `longestEarth`, `batteryKg`, `kWh`) + failing constraint list |
| `search_alternatives` | `baseline`, valid `sites`, `days`, `limits`, `from`, `through` | Executes counterfactual Pareto recovery via Rust/WASM or TS engine |
| `inspect_terrain_sensitivity` | Validated scenario + `limits` | Sweeps 48 km vs 96 km, `sigma = 0` vs `2`, and all 5 mast heights (`1.5..20 m`) |
| `retrieve_scientific_evidence` | Non-empty `query` string, `topK` clamped `1..8` | Returns sanitized passages tagged explicitly as `untrustedEvidenceText` |
| `get_decision_certificate` | Validated `baseline`, `revised`, `days`, `limits` | Builds reproducible `MissionDecisionCertificate` with `deterministicFingerprint` |

## 2. Defense-in-Depth Guardrails (`server/rag.mjs` & `server/researchAgent.mjs`)

1. **Untrusted-Passage Firewall & Prompt-Injection Detection:** `detectPromptInjection` and `sanitizePassageText` strip imperative overrides (`"ignore previous instructions"`, `"certify ... as safe"`, `"override validation"`, `"system prompt"`, script tags) from retrieved passages before synthesis, replacing directives with `[UNTRUSTED_DIRECTIVE_STRIPPED]` and recording `injectionFlags`. Direct adversarial prompts without a valid scientific task abstain with `prompt_injection_rejected`.
2. **Typed Scope & Contradiction Abstention:** `runLocalDeterministicWorkflow` and provider validation enforce explicit abstention codes before speculation:
   - `out_of_epoch` (e.g., November 2028 or full-year requests; citation publication years such as `(2020/2023)` are disambiguated from mission launch dates so citation queries do not false-refuse)
   - `out_of_region` (e.g., North Pole, Tycho crater)
   - `rf_link_budget` (bitrates, EIRP, SNR, DSN scheduling)
   - `water_ice_abundance` (harvestable ice wt% — distinguishes geomorphic PSR from verified volatile assay)
   - `non_modeled_physics` (regolith bearing stress, plume impingement, thermal transients, `<20 m` boulders)
   - `contradictory_requirements` (grounds current scenario metrics first via `get_scenario` and refuses impossible self-contradictions such as keeping fixed-slope Pad #481 `<= 2 deg`)
   - `ambiguous_requirements` (`clarify` status when asking `"Which site is best?"` without constraints)
3. **Post-Generation Grounding Verifier (`verifyGroundedOutput`):** Checks every numeric token extracted from the candidate answer (`extractNumericTokens`) against numbers present in executed tool outputs (allowing verified `Wh <-> kWh` and `deg <-> rad` conversions and bounded structural integers), and checks every cited document/passage ID against retrieved tool outputs. Any external LLM draft failing verification is rejected and replaced safely.

## 3. End-to-End Evaluation Benchmark (`eval/dataset.json`, 28 Cases)

We compared three architectures across 28 labeled test cases covering 13 categories (`constraint_comparison`, `multi_step_tool_use`, `retrieval_and_citation`, `answerable_science`, `unit_conversion`, `out_of_coverage`, `ambiguous_requirements`, `contradictory_requirements`, `hallucination_trap`, `prompt_injection`, `prompt_injection_retrieved`, `outdated_source`, `provider_outage` / `provider_timeout`):

| System Evaluated | Overall Pass | Abstention Acc | False Refusal Rate | Tool Correctness | Numeric Consistency | Citation Support | Unsupported Claim Freq | p50 Latency | p95 Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `legacy_deterministic` (Phase 1–3 JS/TS) | 14/28 (50.0%) | 86.7% | 61.5% | 0.0% | 0.0% | 0.0% | 0.0% | 0.06 ms | 2.35 ms |
| `retrieval_only_rag` (Hybrid RRF, no tools) | 6/28 (21.4%) | 6.7% | 0.0% | 20.0% | 60.0% | 100.0% | 7.1% | 14.43 ms | 31.65 ms |
| **`phase4_constrained_agent`** | **28/28 (100.0%)** | **100.0%** | **0.0%** | **100.0%** | **100.0%** | **100.0%** | **0.0%** | **11.93 ms** | **8223.69 ms*** |

\*Note on `phase4_constrained_agent` `p95` latency and provider mode:

- In this evaluation run, `providerConfiguredEnv` was `false` (external OpenAI-compatible reasoning + schema repair + hallucination rejection were separately exercised against local loopback mock HTTP endpoints in `server/research.test.mjs`, while the 28-case comparison ran through the constrained tool workflow + local simulated fault servers).
- The `8,223.69 ms` `p95` (`8,319.27 ms` `p99`) reflects the deliberate **`search_alternatives` multi-site sweep** and **HTTP 503 retry + timeout chaos test (`e27_provider_outage_503` / `e28_provider_timeout`)** intentionally embedded inside the 28-case suite; normal interactive retrieval and comparison queries sit near `11.9 ms` median latency.
- **Why Retrieval-Only RAG Fails (`21.4%`):** Without deterministic physics tools or abstention logic, retrieval-only RAG answers `93.3%` of impossible/out-of-coverage traps (`abstentionAcc = 6.7%`), cannot run site searches or unit conversions, and emits ungrounded numbers (`7.1%` unsupported claim rate).
- **Why Legacy Deterministic Fails (`50.0%`):** Although legacy never fabricates (`0.0%` unsupported claims), it lacks hybrid citations, counterfactual cross-site search routing, and terrain/mast sensitivity synthesis (`61.5%` false refusal rate on answerable scientific questions).
