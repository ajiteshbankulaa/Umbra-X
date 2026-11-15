# Umbra-X Security Architecture & Hardening

## 1. Threat Model & Trust Boundaries

Umbra-X exposes three security zones:
1. **Static Client Zone (`web/dist/` + `planner-release/`):** Publicly cacheable assets with zero server secrets. Integrity depends on SHA-256 verification of binary terrain/ephemeris payloads ([`web/src/planner/data.ts`](file:///c:/Users/ajite/Desktop/UmbraX/web/src/planner/data.ts)) before use.
2. **Optional API Edge (`server/server.mjs`):** Accepts untrusted browser HTTP requests (`POST /api/study/runs`, `DELETE /api/study/runs/:id`, `POST /api/research/ask`, `POST /api/research/evidence`, `POST /api/telemetry/client`, `GET /api/telemetry/traces`).
3. **Worker & Artifact Zone (`server/worker.mjs` + `server/queue.mjs`):** Executes isolated `worker_threads` study jobs and writes/verifies SHA-256 JSON artifacts on disk.

---

## 2. Implemented Security Controls ([`server/security.mjs`](file:///c:/Users/ajite/Desktop/UmbraX/server/security.mjs) & [`server/server.mjs`](file:///c:/Users/ajite/Desktop/UmbraX/server/server.mjs))

| Control | Implementation | Behavior Under Attack / Misconfiguration |
| :--- | :--- | :--- |
| **Non-Loopback Bind Guard** | `assertSafeBindConfig(host, apiToken)` | Refuses startup if `UMBRA_HOST` is non-loopback (e.g., `0.0.0.0`) without `UMBRA_API_TOKEN` `>= 24` chars and non-placeholder (rejects `changeme`, `secret`, `token`, `default`, `umbra-dev`). |
| **Constant-Time Bearer Auth** | `checkBearerAuth(req, apiToken)` (`crypto.timingSafeEqual`) | Enforced on mutating study/research routes, `DELETE /api/study/runs/:id`, and `GET /api/telemetry/traces` when `apiToken` is configured; returns `HTTP 401` and increments `umbrax_auth_rejections_total`. |
| **Per-IP Token-Bucket Rate Limiting** | `IpRateLimiter` (`90` units / `60,000` ms default; cost `2` on heavy study/ask routes) | Returns `HTTP 429` with `Retry-After` header across `POST` routes including `/api/telemetry/client`. |
| **Safe JSON Body & Prototype Pollution Defense** | `readSafeJsonBody(req, maxBytes)` + `hasForbiddenKeys()` | Enforces byte caps (`16,384` B on study/ask, `4,096` B on telemetry/evidence -> `HTTP 413`) and rejects `__proto__`, `constructor`, and `prototype` keys (`HTTP 400`). |
| **Origin & Security Headers** | Origin allowlist + `applySecurityHeaders()` + Nginx headers | Unknown cross-origins receive `HTTP 403`. Responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and API CSP `default-src 'none'; frame-ancestors 'none'`. |
| **Log & Trace Secret Redaction** | `redactString()` & `sanitizeAttributes()` in [`server/telemetry.mjs`](file:///c:/Users/ajite/Desktop/UmbraX/server/telemetry.mjs) | Scrubs `Bearer ...`, `sk-...`, `AIza...`, and query tokens (`api_key=`, `key=`, `token=`, `secret=`), plus drops sensitive key names from span/log metadata. Verified never to leak `UMBRA_API_TOKEN` in `/metrics` or `/api/telemetry/traces`. |
| **Prompt Injection & Untrusted Evidence Firewall** | `detectPromptInjection()` + `sanitizePassageText()` + `verifyGroundedOutput()` | Strips imperative instructions embedded in RAG chunks (`[UNTRUSTED_DIRECTIVE_STRIPPED]`), rejects raw injection prompts (`prompt_injection_rejected`), and verifies cited IDs and numbers against tool results. |
| **Container Least Privilege** | `Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.web`, `Dockerfile.terrain` | Non-root runtime users (`node` uid `1000`, `nginxinc/nginx-unprivileged`, distroless non-root `65532:65532` for terrain), Compose `no-new-privileges:true`, strict memory/CPU caps. |
| **Artifact Path & Integrity Enforcement** | `readVerifiedResult()` in `queue.mjs` | Rejects path traversal outside `artifactsDir` and throws `ArtifactIntegrityError` (`HTTP 500`) on SHA-256 mismatch. |

---

## 3. Supply-Chain, Dependency Audit & Release Signing Boundary

1. **Web NPM Dependency Audit (`npm --prefix web audit --json` -> [`research/benchmarks/web_audit.json`](file:///c:/Users/ajite/Desktop/UmbraX/research/benchmarks/web_audit.json)):**
   - Observed result: `0` advisories across all severities (`info: 0`, `low: 0`, `moderate: 0`, `high: 0`, `critical: 0`, `total: 0`).
2. **Release Integrity Verification ([`infra/scripts/verify_release_integrity.mjs`](file:///c:/Users/ajite/Desktop/UmbraX/infra/scripts/verify_release_integrity.mjs)):**
   - Locks every site's `horizons.bin` (`961 * 5 * 360 * 4` bytes), regional SHA-256 blobs, shared DE440 ephemeris binary (`b7ca9394446e781b5eaab0308b6e4ca58f471a41ac3eb115dc5e314926238321`, `829,536` B), and `umbra_core.wasm` (`50,415` B, SHA-256 `5643965ede531890ab363f74e381d717e691b8e6b3b2f62a8c8b6fb1016a9351`) into a single composite `releaseFingerprint` (`026908a9918134a256f46f173ab6aa5d949104c3548b123c9a20f69ec88d6b78`).
   - CI release workflow ([`.github/workflows/planner-release.yml`](file:///c:/Users/ajite/Desktop/UmbraX/.github/workflows/planner-release.yml)) verifies external bundle SHA-256 with `sha256sum -c`, rebuilds WASM from `--locked` `Cargo.toml`, checks Python/Node parity, and attaches `release-manifest.json`.

---

## 4. Known Security Limitations & Unaudited Surfaces

- **Trusted Proxy Header Assumption (`server/server.mjs`):** Rate limiting currently reads `req.headers['x-forwarded-for']?.split(',')[0]?.trim()`. If exposed directly on the public Internet *without* a trusted reverse proxy overwriting `X-Forwarded-For`, clients could forge that header to evade `IpRateLimiter`. Deploy behind Nginx/Cloud Run LB (which appends/sets client IP) or configure trusted proxy hop extraction before public API exposure.
- **Unaudited Python/Container Image CVEs:** Local `npm audit` ran cleanly (`0` vulnerabilities), while `pip-audit` and container base-image scanning (`trivy` / `grype` against `node:24.11.0-bookworm-slim` and `nginxinc/nginx-unprivileged:1.27-alpine`) were not executed on this offline host because Docker Desktop Linux Engine is not running locally.
- **`POST /api/telemetry/client` Intentional Anonymity:** Unauthenticated browsers on the dev/Compose origin can send lightweight timing counters (`maxBytes = 4096`), protected by rate limiting and strict field slicing (`48` / `24` chars), not Bearer auth.
