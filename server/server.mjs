import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { horizonEpoch, mastHeights, validatePlan } from './study.mjs'
import { planWithAgent, providerFromEnv } from './agent.mjs'
import { ResearchCorpusRetriever } from './rag.mjs'
import { createScientificToolbox, getSolverMetadata } from './tools.mjs'
import { createOpenAiCompatibleProvider, ResponseLruCache } from './providers.mjs'
import { runConstrainedResearchAgent } from './researchAgent.mjs'
import { ArtifactIntegrityError, IdempotencyConflictError, QueueOverloadedError, StudyQueueStore } from './queue.mjs'
import { createStudyWorkerLoop } from './worker.mjs'
import {
  applySecurityHeaders,
  assertSafeBindConfig,
  checkBearerAuth,
  IpRateLimiter,
  readSafeJsonBody,
} from './security.mjs'
import { createLogger, MetricsRegistry, newSpanId, newTraceId, parseTraceparent, TraceRecorder } from './telemetry.mjs'

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../.env'))
} catch {
  // .env file is optional (process env vars or deterministic local fallback apply)
}

const SITES = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']

export async function createUmbraServer(options = {}) {
  const host = options.host ?? process.env.UMBRA_HOST ?? '127.0.0.1'
  const port = Number(options.port ?? process.env.UMBRA_PORT ?? 8787)
  const apiToken = options.apiToken ?? process.env.UMBRA_API_TOKEN ?? ''
  assertSafeBindConfig(host, apiToken)

  const embeddedWorker = options.embeddedWorker ?? process.env.UMBRA_EMBEDDED_WORKER !== '0'
  const silentLogs = options.silentLogs ?? process.env.UMBRA_SILENT_LOGS === '1'
  const trustProxy = options.trustProxy ?? process.env.UMBRA_TRUST_PROXY === '1'
  const terrainUrl = (options.terrainUrl ?? process.env.UMBRA_TERRAIN_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '')
  const logger = createLogger({ service: 'umbra-api', silent: silentLogs })
  const metrics = new MetricsRegistry()
  const traces = new TraceRecorder('umbra-api', 300)
  const rateLimiter = new IpRateLimiter({
    windowMs: Number(options.rateWindowMs ?? process.env.UMBRA_RATE_WINDOW_MS ?? 60_000),
    maxRequests: Number(options.rateMax ?? process.env.UMBRA_RATE_LIMIT_MAX ?? 90),
  })

  const root = new URL('../web/public/data/planner-release/', import.meta.url)
  const dataset = await Promise.all(
    SITES.map(async site => {
      const manifest = JSON.parse(await readFile(new URL(site + '/planner.json', root), 'utf8'))
      if (manifest.start !== '2026-11-14T00:00:00+00:00' || manifest.count !== 8641 || manifest.stepMinutes !== 5 || !manifest.regional) {
        throw new Error(`Unexpected release metadata for ${site}.`)
      }
      return [site, manifest]
    }),
  )
  const versions = Object.fromEntries(dataset)
  const release = createHash('sha256').update(JSON.stringify(versions)).digest('hex')
  const solver = createHash('sha256')
  for (const name of ['./study.mjs', '../web/src/planner/model.ts', '../web/public/wasm/umbra_core.wasm']) {
    solver.update(await readFile(new URL(name, import.meta.url)))
  }
  const solverVersion = solver.digest('hex')

  const dbPath = resolve(options.dbPath || process.env.UMBRA_STUDY_DB || fileURLToPath(new URL('./state/studies.sqlite', import.meta.url)))
  const artifactsDir = resolve(options.artifactsDir || process.env.UMBRA_ARTIFACTS_DIR || resolve(dirname(dbPath), 'artifacts'))
  const maxQueueDepth = Number(options.maxQueueDepth ?? process.env.UMBRA_MAX_QUEUE_DEPTH ?? 32)
  const store = new StudyQueueStore({ dbPath, artifactsDir, maxQueueDepth })
  store.reclaimExpired()

  const provider = options.provider !== undefined ? options.provider : providerFromEnv()
  const researchProvider = options.researchProvider !== undefined ? options.researchProvider : createOpenAiCompatibleProvider()
  const retriever = options.retriever ?? new ResearchCorpusRetriever()
  const solverMeta = await getSolverMetadata()
  const toolbox = createScientificToolbox({ retriever, coverageMeta: solverMeta })
  const responseCache = new ResponseLruCache(128)
  const startedAt = Date.now()
  let shuttingDown = false
  let modelRequests = 0

  const worker = embeddedWorker
    ? createStudyWorkerLoop({
        store,
        versions,
        metrics,
        traces,
        logger: createLogger({ service: 'umbra-embedded-worker', silent: silentLogs }),
      })
    : null
  if (worker) void worker.start()

  const coverage = {
    epoch: horizonEpoch,
    hours: 720,
    maxDays: 15,
    mastHeights,
    sites: SITES.map(site => ({ site, pads: 961, horizonKm: [48, 96], terrainSource: versions[site].regional.source })),
    ephemeris: 'JPL DE440; checked against JPL Horizons',
    release,
    solverVersion,
    modelConfigured: Boolean(provider || researchProvider),
    authRequiredForWrites: Boolean(apiToken),
    ragCorpus: retriever.corpusMeta,
  }

  function send(res, code, data, extraHeaders = {}) {
    applySecurityHeaders(res)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders })
    res.end(JSON.stringify(data))
  }

  function sendText(res, code, contentType, text, extraHeaders = {}) {
    applySecurityHeaders(res)
    res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders })
    res.end(text)
  }

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost')
    const path = reqUrl.pathname
    const tp = parseTraceparent(req.headers.traceparent)
    const traceId = tp?.traceId ?? newTraceId()
    const correlationId = String(req.headers['x-correlation-id'] ?? randomUUID()).slice(0, 64)
    const span = traces.startSpan(`${req.method} ${path}`, {
      traceId,
      parentSpanId: tp?.parentSpanId ?? null,
      attributes: { method: req.method, route: path, correlationId },
    })
    const resHeaders = { 'x-correlation-id': correlationId, traceparent: span.traceparent }

    let statusCode = 500
    const replyJson = (code, data, hdrs = {}) => {
      statusCode = code
      send(res, code, data, { ...resHeaders, ...hdrs })
    }

    try {
      const origin = req.headers.origin
      const localPreview = /^http:\/\/(?:127\.0\.0\.1|localhost):(?:5174|5173|4173)$/.test(origin ?? '')
      if (origin && !localPreview && ![`http://${req.headers.host}`, `https://${req.headers.host}`, process.env.UMBRA_WEB_ORIGIN].includes(origin)) {
        replyJson(403, { error: 'Origin is outside the configured planner.' })
        return
      }

      if (req.method === 'GET' && path === '/healthz') {
        replyJson(200, { status: 'ok', uptimeSec: Math.round((Date.now() - startedAt) / 1000), release })
        return
      }

      if (req.method === 'GET' && path === '/readyz') {
        if (shuttingDown) {
          replyJson(503, { status: 'draining' })
          return
        }
        const depths = store.queueDepthByState()
        replyJson(200, { status: 'ready', release, solverVersion, queue: depths })
        return
      }

      if (req.method === 'GET' && path === '/metrics') {
        const depths = store.queueDepthByState()
        for (const [st, val] of Object.entries(depths)) {
          metrics.setGauge('umbrax_study_queue_depth', 'Current number of studies in each lifecycle state', { state: st }, val)
        }
        const cacheSt = responseCache.stats()
        metrics.setGauge('umbrax_response_cache_entries', 'Current cached research answers', {}, cacheSt.size)
        statusCode = 200
        sendText(res, 200, 'text/plain; version=0.0.4; charset=utf-8', metrics.toPrometheusText(), resHeaders)
        return
      }

      const isMutating =
        (req.method === 'POST' && ['/api/study/runs', '/api/study/interpret', '/api/research/ask', '/api/research/evidence'].includes(path)) ||
        req.method === 'DELETE'
      const isTraceRead = req.method === 'GET' && path === '/api/telemetry/traces'

      const forwardedIp = trustProxy ? req.headers['x-forwarded-for']?.split(',')[0]?.trim() : null
      const clientIp = forwardedIp || req.socket.remoteAddress || 'local'
      if (isMutating || req.method === 'POST') {
        const cost = path === '/api/study/runs' || path === '/api/research/ask' ? 2 : 1
        const rl = rateLimiter.allow(clientIp, cost)
        if (!rl.allowed) {
          replyJson(429, { error: 'Rate limit exceeded. Retry later.' }, { 'Retry-After': String(rl.retryAfterSec) })
          return
        }
      }

      if ((isMutating || isTraceRead) && apiToken) {
        const auth = checkBearerAuth(req, apiToken)
        if (!auth.ok) {
          metrics.incCounter('umbrax_auth_rejections_total', 'Rejected unauthenticated API calls', { reason: auth.reason })
          replyJson(401, { error: 'Valid Bearer authorization token required.' })
          return
        }
      }

      if (req.method === 'GET' && path === '/api/study/coverage') {
        replyJson(200, { ...coverage, cacheStats: responseCache.stats() })
        return
      }

      if (req.method === 'GET' && path === '/api/telemetry/traces') {
        replyJson(200, { service: 'umbra-api', spanCount: traces.spans.length, spans: traces.recent(40) })
        return
      }

      if (req.method === 'POST' && path === '/api/telemetry/client') {
        const body = await readSafeJsonBody(req, 4096)
        const eventType = String(body.event ?? 'unknown').slice(0, 48)
        const engine = String(body.engine ?? 'unknown').slice(0, 24)
        metrics.incCounter('umbrax_browser_telemetry_events_total', 'Frontend Web Worker and WASM telemetry events', { event: eventType, engine })
        if (Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0) {
          metrics.observeHistogram('umbrax_browser_compute_duration_ms', 'Browser compute duration in ms', { event: eventType, engine }, body.elapsedMs)
        }
        if (eventType === 'wasm_fallback') {
          metrics.incCounter('umbrax_wasm_fallbacks_total', 'Browser WASM load or parity fallback count', {})
        }
        if (eventType === 'data_version_error') {
          metrics.incCounter('umbrax_data_version_errors_total', 'Detected dataset version or checksum mismatches', { source: 'browser' })
        }
        replyJson(202, { accepted: true })
        return
      }

      if (req.method === 'POST' && path === '/api/research/evidence') {
        const { query, mode = 'hybrid_rrf', topK = 5 } = await readSafeJsonBody(req, 4096)
        if (typeof query !== 'string' || !query.trim() || query.length > 500) {
          throw new Error('Enter a query of up to 500 characters.')
        }
        const t0 = performance.now()
        const hits = await retriever.search(query, { mode, topK: Math.max(1, Math.min(8, Number(topK) || 5)) })
        const dt = performance.now() - t0
        metrics.incCounter('umbrax_rag_queries_total', 'Hybrid RAG passage lookups', { mode: hits.mode, cache_hit: String(Boolean(hits.cacheHit)) })
        metrics.observeHistogram('umbrax_rag_latency_ms', 'Hybrid RAG latency in ms', { mode: hits.mode }, dt)
        replyJson(200, hits)
        return
      }

      if (req.method === 'GET' && (path === '/api/polar-horizon' || path === '/api/horizon')) {
        const latParam = reqUrl.searchParams.get('lat')
        const lonParam = reqUrl.searchParams.get('lon')
        const lat = latParam === null ? NaN : Number(latParam)
        const lon = lonParam === null ? NaN : Number(lonParam)
        const mast = Number(reqUrl.searchParams.get('mast') ?? '5')
        const radius = Number(reqUrl.searchParams.get('max_dist_m') ?? '96000')
        if (
          !Number.isFinite(lat) || lat < -90 || lat > -80 ||
          !Number.isFinite(lon) || lon < -180 || lon > 360 ||
          !Number.isFinite(mast) || mast < 0 || mast > 50 ||
          ![48000, 96000, 144000].includes(radius)
        ) {
          replyJson(400, { supported: false, error: 'Coordinate, mast, or radius outside supported LDEM_80S range.' })
          return
        }
        try {
          const upstream = await fetch(`${terrainUrl}/api/polar-horizon?${reqUrl.searchParams.toString()}`, {
            signal: AbortSignal.timeout(60_000),
          })
          const payload = await upstream.json()
          replyJson(upstream.status, payload)
        } catch {
          replyJson(503, { supported: false, error: 'Live LOLA terrain service unavailable.' })
        }
        return
      }

      if (req.method === 'POST' && path === '/api/research/ask') {
        const { question, context, history } = await readSafeJsonBody(req, 24576)
        if (typeof question !== 'string' || !question.trim() || question.length > 800) {
          throw new Error('Enter a question of up to 800 characters.')
        }
        const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream')
        const reqAc = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) reqAc.abort('user_cancelled')
        })
        const signal = AbortSignal.any([AbortSignal.timeout(70_000), reqAc.signal])
        const t0 = performance.now()

        if (wantsSse) {
          applySecurityHeaders(res)
          statusCode = 200
          res.writeHead(200, {
            ...resHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            Connection: 'keep-alive',
          })
          const writeEvent = (eventName, payload) => {
            if (!res.writableEnded) res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
          }
          try {
            const answer = await runConstrainedResearchAgent(question, context ?? {}, {
              toolbox,
              provider: researchProvider,
              cache: responseCache,
              history,
              solverVersion,
              signal,
              onProgress: ev => writeEvent('progress', ev),
            })
            const dt = performance.now() - t0
            metrics.incCounter('umbrax_model_invocations_total', 'Constrained research agent invocations', {
              provider: answer.providerMode,
              status: answer.status,
              cache_hit: String(Boolean(answer.cacheHit)),
            })
            metrics.incCounter('umbrax_cache_events_total', 'Response cache outcomes', {
              cache: 'research_response',
              outcome: answer.cacheHit ? 'hit' : 'miss',
            })
            metrics.observeHistogram('umbrax_model_latency_ms', 'Constrained research agent latency in ms', { provider: answer.providerMode }, dt)
            writeEvent('result', answer)
          } catch (err) {
            if (!reqAc.signal.aborted) {
              writeEvent('error', { error: err?.message ?? 'Agent request failed.' })
            }
          } finally {
            if (!res.writableEnded) res.end()
          }
          return
        }

        const answer = await runConstrainedResearchAgent(question, context ?? {}, {
          toolbox,
          provider: researchProvider,
          cache: responseCache,
          history,
          solverVersion,
          signal,
        })
        const dt = performance.now() - t0
        metrics.incCounter('umbrax_model_invocations_total', 'Constrained research agent invocations', {
          provider: answer.providerMode,
          status: answer.status,
          cache_hit: String(Boolean(answer.cacheHit)),
        })
        metrics.incCounter('umbrax_cache_events_total', 'Response cache outcomes', {
          cache: 'research_response',
          outcome: answer.cacheHit ? 'hit' : 'miss',
        })
        metrics.observeHistogram('umbrax_model_latency_ms', 'Constrained research agent latency in ms', { provider: answer.providerMode }, dt)
        replyJson(200, answer)
        return
      }

      if (req.method === 'POST' && path === '/api/study/interpret') {
        if (!provider) {
          replyJson(503, { error: 'Model provider is not configured.' })
          return
        }
        if (modelRequests >= 2) {
          replyJson(429, { error: 'The agent is busy.' })
          return
        }
        const { question, context } = await readSafeJsonBody(req, 8192)
        if (typeof question !== 'string' || !question.trim() || question.length > 500) {
          throw new Error('Enter a question of up to 500 characters.')
        }
        modelRequests++
        const t0 = performance.now()
        try {
          const answer = await planWithAgent(question, context, coverage, provider, AbortSignal.timeout(25_000))
          metrics.incCounter('umbrax_model_invocations_total', 'Study planner LLM invocations', { provider: 'legacy-study', status: answer.status, cache_hit: 'false' })
          metrics.observeHistogram('umbrax_model_latency_ms', 'Study planner LLM latency in ms', { provider: 'legacy-study' }, performance.now() - t0)
          replyJson(200, answer)
        } catch (error) {
          metrics.incCounter('umbrax_model_invocations_total', 'Study planner LLM invocations', { provider: 'legacy-study', status: 'error', cache_hit: 'false' })
          replyJson(502, { error: error.message })
        } finally {
          modelRequests--
        }
        return
      }

      if (req.method === 'POST' && path === '/api/study/runs') {
        if (shuttingDown) {
          replyJson(503, { error: 'Server is draining; retry shortly.' })
          return
        }
        const body = await readSafeJsonBody(req, 16384)
        const plan = validatePlan(body.plan)
        const sigma = body.sigma ?? 0
        if (!Number.isFinite(sigma) || sigma < 0 || sigma > 3) {
          throw new Error('Local error multiplier must be between 0 and 3.')
        }
        const idempotencyKey = req.headers['idempotency-key'] ?? body.idempotencyKey ?? null
        const input = { plan, power: { sigma }, release, solver: solverVersion }
        const { row, reused } = store.submitStudy({ input, idempotencyKey, traceId })
        metrics.incCounter('umbrax_study_submissions_total', 'Total study submissions', {
          kind: plan.kind,
          reused: String(reused),
        })
        replyJson(reused ? 200 : 202, { ...store.view(row, worker?.getActiveProgress(row.id) ?? null), reused })
        return
      }

      const id = path.match(/^\/api\/study\/runs\/([a-f0-9-]{36})$/)?.[1]
      if (id) {
        const row = store.getById(id)
        if (row && req.method === 'GET') {
          replyJson(200, store.view(row, worker?.getActiveProgress(id) ?? null))
          return
        }
        if (row && req.method === 'DELETE') {
          const updated = store.cancelJob(id)
          replyJson(200, store.view(updated, worker?.getActiveProgress(id) ?? null))
          return
        }
      }

      replyJson(404, { error: 'Study endpoint or run not found.' })
    } catch (error) {
      const code =
        error instanceof IdempotencyConflictError ? 409
          : error instanceof QueueOverloadedError ? 429
            : error instanceof ArtifactIntegrityError ? 500
              : Number.isInteger(error?.statusCode) ? error.statusCode
                : 400
      if (code === 500) {
        metrics.incCounter('umbrax_data_version_errors_total', 'Artifact or version verification errors', { source: 'api' })
      }
      if (!res.headersSent) replyJson(code, { error: error.message })
    } finally {
      const finishedSpan = span.end({
        status: statusCode >= 500 ? 'ERROR' : 'OK',
        extraAttributes: { httpStatus: statusCode },
      })
      metrics.incCounter('umbrax_http_requests_total', 'Total API HTTP requests', {
        route: path.startsWith('/api/study/runs/') ? '/api/study/runs/:id' : path,
        method: req.method,
        status: String(statusCode),
      })
      metrics.observeHistogram('umbrax_http_request_duration_ms', 'HTTP request latency in ms', {
        route: path.startsWith('/api/study/runs/') ? '/api/study/runs/:id' : path,
        method: req.method,
      }, finishedSpan.durationMs)
      logger.info('HTTP request completed', {
        correlationId,
        traceId,
        spanId: finishedSpan.spanId,
        method: req.method,
        path,
        status: statusCode,
        durationMs: finishedSpan.durationMs,
      })
    }
  })

  await new Promise(resolveListen => server.listen(port, host, resolveListen))
  const boundAddress = server.address()
  logger.info('Umbra-X study & research API listening', {
    host,
    port: boundAddress.port,
    embeddedWorker,
    authRequired: Boolean(apiToken),
    ragChunks: retriever.corpusMeta.chunkCount,
    release,
  })

  async function close() {
    shuttingDown = true
    if (worker) await worker.stop()
    await new Promise(r => server.close(r))
    retriever.close()
    store.close()
  }

  return { server, store, worker, metrics, traces, retriever, release, solverVersion, port: boundAddress.port, close }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const handle = await createUmbraServer()
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await handle.close()
      process.exit(0)
    })
  }
}
