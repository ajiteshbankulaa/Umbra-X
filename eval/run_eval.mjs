import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const cliArgs = process.argv.slice(2)
if (cliArgs.includes('--with-env')) {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'))
  } catch {
    // Optional .env file
  }
}
const onlyArgIdx = cliArgs.indexOf('--only')
const onlyCaseId = onlyArgIdx >= 0 ? cliArgs[onlyArgIdx + 1] : null

import { ResearchCorpusRetriever, sanitizePassageText } from '../server/rag.mjs'
import { createScientificToolbox, getSolverMetadata } from '../server/tools.mjs'
import { createOpenAiCompatibleProvider } from '../server/providers.mjs'
import { runConstrainedResearchAgent } from '../server/researchAgent.mjs'
import { interpretStudy } from '../web/src/planner/studyRequest.ts'
import { answerScenarioQuestion, buildComparisonRecord } from '../web/src/planner/explain.ts'
import { analyze, defaultPower } from '../web/src/planner/model.ts'
import { buildObserver, loadPolarSiteBundle } from '../web/src/planner/benchmark.mjs'

const DATASET_PATH = resolve(HERE, 'dataset.json')
const OUT_PATH = resolve(ROOT, 'research/benchmarks/ai_eval_report.json')

const defaultContext = {
  scenarios: [
    { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
  ],
  days: 15,
  limits: { dark: 48, earth: 72, slope: 5 },
}

function percentile(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)
  return Number(s[Math.max(0, idx)].toFixed(2))
}

async function buildLegacyComparisonRecord() {
  const b = await loadPolarSiteBundle('shackleton-ridge')
  const items = defaultContext.scenarios.map(s => {
    const pad = buildObserver(b, s.node, s.mast)
    const report = analyze(pad, b.vectors, s.start * 12, defaultContext.days * 288, b.meta, defaultPower)
    return { report, pad, meta: b.meta, hasRegionalTerrain: true, siteName: 'Shackleton Ridge' }
  })
  return buildComparisonRecord({
    scenarios: defaultContext.scenarios,
    items,
    days: 15,
    limits: defaultContext.limits,
    power: defaultPower,
  })
}

async function runLegacyBaseline(c, legacyRecord) {
  const t0 = performance.now()
  const q = c.question.trim()
  if (!q) {
    return { status: 'abstain', text: 'Clarification needed.', docIds: [], toolTrace: [], latencyMs: performance.now() - t0 }
  }
  const study = interpretStudy(q, { ...defaultContext, active: 0, epoch: '2026-11-14T00:00:00Z', hours: 720 })
  if (study.status === 'coverage' || study.status === 'unsupported') {
    return { status: 'abstain', text: study.message, docIds: [], toolTrace: [], latencyMs: performance.now() - t0 }
  }
  const ans = answerScenarioQuestion(legacyRecord, q)
  return {
    status: 'answered',
    text: `${ans.headline} ${ans.explanation} ${(ans.caveats ?? []).join(' ')}`,
    docIds: (ans.citations ?? []).map(x => x.id),
    toolTrace: [],
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  }
}

async function runRetrievalOnlyBaseline(c, retriever) {
  const t0 = performance.now()
  const res = await retriever.search(c.question || 'lunar mission', { mode: 'hybrid_rrf', topK: 3 })
  const passages = res.results ?? []
  const text = passages.map(p => `${p.title}: ${p.text}`).join(' ')
  return {
    status: c.question.trim() ? 'answered' : 'abstain',
    text,
    docIds: passages.map(p => p.docId),
    toolTrace: ['retrieve_scientific_evidence'],
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  }
}

function checkNumbersPresent(text, expectedNums) {
  if (!expectedNums?.length) return true
  const nums = (String(text).match(/[-+]?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite)
  return expectedNums.every(target => nums.some(v => Math.abs(v - target) <= Math.max(0.15, Math.abs(target) * 0.02)))
}

function checkStringsPresent(text, reqs) {
  if (!reqs?.length) return true
  const low = String(text).toLowerCase()
  return reqs.every(s => low.includes(s.toLowerCase()))
}

function scoreCase(c, run) {
  const wantsAbstain = c.expectedStatus === 'abstain' || c.expectedStatus === 'clarify'
  const gotAbstain = run.status === 'abstain' || run.status === 'clarify'
  const abstentionCorrect = wantsAbstain ? gotAbstain : !gotAbstain

  const forbiddenHit = (c.forbiddenSubstrings ?? []).some(sub =>
    String(run.text ?? '').toLowerCase().includes(sub.toLowerCase()),
  )
  const expectedNumsOk = wantsAbstain ? true : checkNumbersPresent(run.text, c.expectedNumbers)
  const expectedStringsOk = wantsAbstain ? true : checkStringsPresent(run.text, c.requiredSubstrings)
  const expectedToolsOk =
    !c.expectedTools?.length ||
    c.expectedTools.every(t => (run.toolTrace ?? []).includes(t))
  const expectedCitationOk =
    !c.expectedDocIds?.length ||
    c.expectedDocIds.some(d => (run.docIds ?? []).includes(d))

  const ungroundedCount = run.groundingCheck ? run.groundingCheck.ungroundedNumbers.length + run.groundingCheck.invalidCitations.length : 0
  const unsupportedClaim = forbiddenHit || ungroundedCount > 0 || (!wantsAbstain && gotAbstain === false && !expectedNumsOk && (c.expectedNumbers?.length ?? 0) > 0)

  const passed =
    abstentionCorrect &&
    !forbiddenHit &&
    expectedNumsOk &&
    expectedStringsOk &&
    expectedToolsOk &&
    expectedCitationOk &&
    ungroundedCount === 0

  return {
    id: c.id,
    category: c.category,
    passed,
    abstentionCorrect,
    expectedToolsOk,
    expectedNumsOk,
    expectedCitationOk,
    unsupportedClaim,
    forbiddenHit,
    status: run.status,
    expectedStatus: c.expectedStatus,
    latencyMs: run.latencyMs,
    tokens: run.tokenUsage?.totalTokens ?? 0,
    costUsd: run.estimatedCostUsd ?? 0,
    detail: passed
      ? null
      : {
          abstentionCorrect,
          expectedToolsOk,
          expectedNumsOk,
          expectedStringsOk,
          expectedCitationOk,
          forbiddenHit,
          ungroundedCount,
          answerSnippet: String(run.text ?? '').slice(0, 180),
        },
  }
}

async function main() {
  const dataset = JSON.parse(await readFile(DATASET_PATH, 'utf8'))
  const cases = dataset.cases
  const retriever = new ResearchCorpusRetriever()
  const meta = await getSolverMetadata()
  const legacyRecord = await buildLegacyBaselineWrapper(retriever, meta, dataset)
  retriever.close()
  void legacyRecord
}

async function buildLegacyBaselineWrapper(retriever, meta, dataset) {
  const cases = onlyCaseId ? dataset.cases.filter(c => c.id === onlyCaseId) : dataset.cases
  if (!cases.length) throw new Error(`No eval case matched --only ${onlyCaseId}`)
  const legacyRecord = await buildLegacyComparisonRecord()

  // Warmup retriever
  await retriever.search('warm query', { mode: 'hybrid_rrf', topK: 2 })

  const faultServers = []
  const outResults = { legacy_deterministic: [], retrieval_only_rag: [], phase4_constrained_agent: [] }

  for (const c of cases) {
    // 1. Legacy deterministic baseline
    const leg = await runLegacyBaseline(c, legacyRecord)
    outResults.legacy_deterministic.push(scoreCase(c, leg))

    // 2. Retrieval-only RAG baseline (uses raw retriever with no physics tools)
    const rag = await runRetrievalOnlyBaseline(c, retriever)
    outResults.retrieval_only_rag.push(scoreCase(c, rag))

    // 3. Phase 4 Constrained Scientific Agent (with test-injected adversarial/fault modes)
    const wrappedRetriever = {
      async search(q, opts) {
        const res = await retriever.search(q, opts)
        if (c.injectAdversarialPassage) {
          const clean = sanitizePassageText(c.injectAdversarialPassage)
          res.results = [
            {
              passageId: 'adversarial#p000',
              docId: 'ntrs-glaser-2017',
              title: 'Injected Untrusted Chunk',
              citation: 'Untrusted',
              sourceUrl: 'https://example.invalid',
              contentSha256: '0'.repeat(64),
              score: 0.99,
              injectionFlags: clean.injectionFlags,
              text: clean.text,
            },
            ...res.results,
          ]
        }
        if (c.injectStalePassage) {
          const clean = sanitizePassageText(c.injectStalePassage)
          res.results = [
            {
              passageId: 'stale#p000',
              docId: 'ntrs-polar-energy-2008',
              title: 'Superseded Early Note',
              citation: 'Old Note (2010)',
              sourceUrl: 'https://example.invalid',
              contentSha256: '1'.repeat(64),
              score: 0.98,
              injectionFlags: clean.injectionFlags,
              text: clean.text,
            },
            ...res.results,
          ]
        }
        return res
      },
    }
    const toolbox = createScientificToolbox({ retriever: wrappedRetriever, coverageMeta: meta })

    let provider = createOpenAiCompatibleProvider()
    let signal
    let srv = null
    if (c.simulateProviderOutage) {
      srv = createServer((req, res) => {
        res.writeHead(c.simulateProviderOutage, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Simulated outage' }))
      })
      await new Promise(r => srv.listen(0, '127.0.0.1', r))
      faultServers.push(srv)
      provider = createOpenAiCompatibleProvider({
        UMBRA_MODEL_URL: `http://127.0.0.1:${srv.address().port}/v1/chat/completions`,
        UMBRA_MODEL: 'outage-sim',
        UMBRA_MODEL_RETRIES: '1',
      })
    } else if (c.simulateProviderTimeoutMs) {
      srv = createServer((req, res) => {
        setTimeout(() => { if (!res.writableEnded) res.end('{}') }, 2000)
      })
      await new Promise(r => srv.listen(0, '127.0.0.1', r))
      faultServers.push(srv)
      provider = createOpenAiCompatibleProvider({
        UMBRA_MODEL_URL: `http://127.0.0.1:${srv.address().port}/v1/chat/completions`,
        UMBRA_MODEL: 'timeout-sim',
        UMBRA_MODEL_RETRIES: '0',
      })
      signal = AbortSignal.timeout(c.simulateProviderTimeoutMs)
    }

    const agentOut = await runConstrainedResearchAgent(
      c.question,
      c.context ?? defaultContext,
      { toolbox, provider, signal },
    )
    if (srv) srv.close()

    outResults.phase4_constrained_agent.push(
      scoreCase(c, {
        status: agentOut.status,
        text: agentOut.answer,
        docIds: (agentOut.citations ?? []).map(x => x.docId ?? x).filter(Boolean),
        toolTrace: agentOut.toolTrace,
        groundingCheck: agentOut.groundingCheck,
        latencyMs: agentOut.latencyMs,
        tokenUsage: agentOut.tokenUsage,
        estimatedCostUsd: agentOut.estimatedCostUsd,
      }),
    )
  }

  const summaries = {}
  for (const [sysName, rows] of Object.entries(outResults)) {
    const n = rows.length
    const lats = rows.map(r => r.latencyMs)
    const abstCases = rows.filter(r => r.expectedStatus === 'abstain' || r.expectedStatus === 'clarify')
    const answerCases = rows.filter(r => r.expectedStatus === 'answered')
    const toolCases = rows.filter(r => cHasTools(cases, r.id))
    const citeCases = rows.filter(r => cHasCites(cases, r.id))
    const numCases = rows.filter(r => cHasNums(cases, r.id))

    summaries[sysName] = {
      casesTotal: n,
      overallPassCount: rows.filter(r => r.passed).length,
      overallPassRate: Number((rows.filter(r => r.passed).length / n).toFixed(4)),
      abstentionAccuracy: Number((abstCases.filter(r => r.abstentionCorrect).length / Math.max(1, abstCases.length)).toFixed(4)),
      falseRefusalRate: Number((answerCases.filter(r => !r.abstentionCorrect).length / Math.max(1, answerCases.length)).toFixed(4)),
      toolCallCorrectness: Number((toolCases.filter(r => r.expectedToolsOk).length / Math.max(1, toolCases.length)).toFixed(4)),
      numericConsistencyRate: Number((numCases.filter(r => r.expectedNumsOk).length / Math.max(1, numCases.length)).toFixed(4)),
      citationSupportRate: Number((citeCases.filter(r => r.expectedCitationOk).length / Math.max(1, citeCases.length)).toFixed(4)),
      unsupportedClaimFrequency: Number((rows.filter(r => r.unsupportedClaim).length / n).toFixed(4)),
      latencyMs: {
        p50: percentile(lats, 50),
        p95: percentile(lats, 95),
        p99: percentile(lats, 99),
      },
      totalTokens: rows.reduce((a, b) => a + b.tokens, 0),
      totalCostUsd: Number(rows.reduce((a, b) => a + b.costUsd, 0).toFixed(6)),
      failedCases: rows.filter(r => !r.passed),
    }
  }

  const report = {
    datasetVersion: dataset.datasetVersion,
    caseCount: cases.length,
    providerConfiguredEnv: Boolean(process.env.UMBRA_MODEL_URL),
    summaries,
  }
  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2), 'utf8')

  for (const [sysName, s] of Object.entries(summaries)) {
    console.log(
      `${sysName.padEnd(26)} | pass=${s.overallPassCount}/${s.casesTotal} (${(s.overallPassRate * 100).toFixed(1)}%)` +
      ` | abstainAcc=${(s.abstentionAccuracy * 100).toFixed(1)}% tool=${(s.toolCallCorrectness * 100).toFixed(1)}%` +
      ` | num=${(s.numericConsistencyRate * 100).toFixed(1)}% cite=${(s.citationSupportRate * 100).toFixed(1)}%` +
      ` | unsupp=${(s.unsupportedClaimFrequency * 100).toFixed(1)}% | p50=${s.latencyMs.p50}ms p95=${s.latencyMs.p95}ms`,
    )
  }
}

const cHasTools = (cases, id) => Boolean(cases.find(x => x.id === id)?.expectedTools?.length)
const cHasCites = (cases, id) => Boolean(cases.find(x => x.id === id)?.expectedDocIds?.length)
const cHasNums = (cases, id) => Boolean(cases.find(x => x.id === id)?.expectedNumbers?.length)

main().catch(err => {
  console.error(err)
  process.exit(1)
})
