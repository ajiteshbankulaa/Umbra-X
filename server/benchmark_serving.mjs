import { writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ResearchCorpusRetriever } from './rag.mjs'
import { createScientificToolbox } from './tools.mjs'
import { createOpenAiCompatibleProvider, ResponseLruCache } from './providers.mjs'
import { runConstrainedResearchAgent } from './researchAgent.mjs'
import { buildObserver, loadPolarSiteBundle } from '../web/src/planner/benchmark.mjs'
import { analyze, defaultPower } from '../web/src/planner/model.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_PATH = resolve(ROOT, 'research/benchmarks/serving_node.json')

const defaultContext = {
  scenarios: [
    { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
  ],
  days: 15,
  limits: { dark: 48, earth: 72, slope: 5 },
}

function pctl(arr, p) {
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, max(0, Math.ceil((p / 100) * s.length) - 1))
  return Number(s[idx].toFixed(3))
}

function max(a, b) {
  return a > b ? a : b
}

async function benchExactPhysicsBaseline() {
  const b = await loadPolarSiteBundle('shackleton-ridge')
  const pad = buildObserver(b, 480, 2)
  // Warmup
  analyze(pad, b.vectors, 0, 15 * 288, b.meta, defaultPower, 0)
  const timesSingle = []
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now()
    analyze(pad, b.vectors, (i % 12) * 12, 15 * 288, b.meta, defaultPower, 0)
    analyze(pad, b.vectors, (i % 12) * 12, 15 * 288, b.meta, defaultPower, 2)
    timesSingle.push(performance.now() - t0)
  }
  // Full 961-pad 1-start dual (0-sigma + 2-sigma) exact sweep in JS
  const tGrid0 = performance.now()
  for (let node = 0; node < 961; node++) {
    const p = buildObserver(b, node, 2)
    analyze(p, b.vectors, 0, 15 * 288, b.meta, defaultPower, 0)
    analyze(p, b.vectors, 0, 15 * 288, b.meta, defaultPower, 2)
  }
  const grid961Ms = performance.now() - tGrid0
  return {
    singlePadDual0And2SigmaMs: {
      p50: pctl(timesSingle, 50),
      p95: pctl(timesSingle, 95),
    },
    full961PadGridDualMs: Number(grid961Ms.toFixed(2)),
    throughputPadsPerSec: Number(((961 * 1000) / grid961Ms).toFixed(1)),
  }
}

async function benchToolOrchestrationAndRag(toolbox, retriever) {
  const coldRagT0 = performance.now()
  await retriever.search('Shackleton Ridge LOLA 96km elevation error', { mode: 'hybrid_rrf', topK: 4 })
  const coldRagMs = performance.now() - coldRagT0

  const ragWarmUncached = []
  const ragWarmCached = []
  const qs = [
    'LOLA elevation error Barker Mazarico',
    'JPL DE440 MOON_ME reference frame',
    'Goldstone DSS-14 elevation mask 10 degrees',
  ]
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await retriever.search(`${qs[i % qs.length]} probe ${i}`, { mode: 'hybrid_rrf', topK: 4 })
    ragWarmUncached.push(performance.now() - t0)
  }
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await retriever.search(qs[0], { mode: 'hybrid_rrf', topK: 4 })
    ragWarmCached.push(performance.now() - t0)
  }

  const toolBench = {}
  const toolCases = [
    ['get_scenario', { site: 'shackleton-ridge', node: 480, start: 0, mast: 2, days: 15 }],
    ['compare_scenarios', { baseline: defaultContext.scenarios[0], revised: defaultContext.scenarios[1], days: 15, limits: defaultContext.limits }],
    ['inspect_terrain_sensitivity', { site: 'shackleton-ridge', node: 480, start: 0, mast: 2, days: 15, limits: defaultContext.limits }],
    ['search_alternatives', { baseline: defaultContext.scenarios[0], revised: defaultContext.scenarios[1], sites: ['shackleton-ridge', 'mons-mouton', 'malapert-massif'], days: 15, limits: defaultContext.limits }],
  ]
  for (const [name, args] of toolCases) {
    // cold + warmup
    const coldT0 = performance.now()
    await toolbox.execute(name, args, defaultContext)
    const coldMs = performance.now() - coldT0
    const runs = name === 'search_alternatives' ? 5 : 15
    const lats = []
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      await toolbox.execute(name, args, defaultContext)
      lats.push(performance.now() - t0)
    }
    toolBench[name] = {
      coldMs: Number(coldMs.toFixed(2)),
      p50Ms: pctl(lats, 50),
      p95Ms: pctl(lats, 95),
    }
  }

  return {
    ragBridgeColdMs: Number(coldRagMs.toFixed(2)),
    ragBridgeWarmUncachedMs: { p50: pctl(ragWarmUncached, 50), p95: pctl(ragWarmUncached, 95) },
    ragBridgeCacheHitMs: { p50: pctl(ragWarmCached, 50), p95: pctl(ragWarmCached, 95) },
    tools: toolBench,
  }
}

async function benchCacheAndConcurrency(toolbox) {
  const cache = new ResponseLruCache(64)
  const q = 'Why does this launch delay improve Earth visibility but not recover the mission?'

  const tCold0 = performance.now()
  const r1 = await runConstrainedResearchAgent(q, defaultContext, { toolbox, cache })
  const coldMs = performance.now() - tCold0

  const hitTimes = []
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now()
    await runConstrainedResearchAgent(q, defaultContext, { toolbox, cache })
    hitTimes.push(performance.now() - t0)
  }

  // Concurrency burst (12 parallel mixed requests: cache hits + fresh scenario/abstention calls)
  const queries = [
    q,
    'Find another pad in Mons Mouton that satisfies these geometric limits.',
    'What JPL ephemeris and validation checks back the Sun and Earth vectors?',
    'What RF downlink bitrate in Mbps does Pad #479 achieve?',
  ]
  const tBurst0 = performance.now()
  const burstResults = await Promise.all(
    Array.from({ length: 12 }, (_, idx) =>
      runConstrainedResearchAgent(queries[idx % queries.length], defaultContext, { toolbox, cache }),
    ),
  )
  const burstTotalMs = performance.now() - tBurst0

  return {
    agentColdCompareMs: Number(coldMs.toFixed(2)),
    cacheHitMs: { p50: pctl(hitTimes, 50), p95: pctl(hitTimes, 95) },
    cacheSpeedupFactor: Number((coldMs / Math.max(0.005, pctl(hitTimes, 50))).toFixed(1)),
    concurrency12BurstTotalMs: Number(burstTotalMs.toFixed(2)),
    concurrency12ThroughputRps: Number(((12 * 1000) / burstTotalMs).toFixed(2)),
    burstCacheHits: burstResults.filter(r => r.cacheHit).length,
  }
}

async function benchRetryRecoveryAndCost(toolbox) {
  let attempts = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      attempts++
      if (attempts <= 2) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'temporary overload' }))
        return
      }
      const parsed = JSON.parse(body)
      const hasTool = parsed.messages.some(m => m.role === 'tool')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (!hasTool) {
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'get_scenario', arguments: JSON.stringify({ site: 'shackleton-ridge', node: 480, start: 48, mast: 2, days: 15 }) } }] } }],
          usage: { prompt_tokens: 420, completion_tokens: 35, total_tokens: 455 },
        }))
      } else {
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'answered', answer: 'Verified Shackleton Pad #481 (+48h): slope is 5.6 deg, max dark 52.75 h, Earth outage 55.67 h.', citations: [] }) } }],
          usage: { prompt_tokens: 680, completion_tokens: 48, total_tokens: 728 },
        }))
      }
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const provider = createOpenAiCompatibleProvider({
    UMBRA_MODEL_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
    UMBRA_MODEL: 'gpt-4o-mini',
    UMBRA_MODEL_KEY: 'bench-key',
    UMBRA_MODEL_RETRIES: '2',
    UMBRA_COST_INPUT_PER_M: '0.15',
    UMBRA_COST_OUTPUT_PER_M: '0.60',
  })
  const t0 = performance.now()
  const out = await runConstrainedResearchAgent('Check Shackleton Pad #481 at +48h', defaultContext, { toolbox, provider })
  const elapsedMs = performance.now() - t0
  server.close()

  return {
    transient503Attempts: attempts,
    recoveredStatus: out.status,
    groundingPassed: out.groundingCheck?.grounded ?? false,
    retryRecoveryElapsedMs: Number(elapsedMs.toFixed(2)),
    tokenUsage: out.tokenUsage,
    estimatedCostUsd: out.estimatedCostUsd,
    costPer1kQueriesUsd: Number((out.estimatedCostUsd * 1000).toFixed(4)),
  }
}

async function main() {
  const retriever = new ResearchCorpusRetriever()
  const toolbox = createScientificToolbox({ retriever })

  const physics = await benchExactPhysicsBaseline()
  const toolsAndRag = await benchToolOrchestrationAndRag(toolbox, retriever)
  const cacheAndConcurrency = await benchCacheAndConcurrency(toolbox)
  const retryAndCost = await benchRetryRecoveryAndCost(toolbox)

  await retriever.close()

  const report = {
    benchmarkVersion: 'phase4-node-serving-v1',
    nodeVersion: process.version,
    physics,
    toolsAndRag,
    cacheAndConcurrency,
    retryAndCost,
  }
  await mkdir(resolve(ROOT, 'research/benchmarks'), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
