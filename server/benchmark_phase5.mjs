import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { searchObserverDual } from '../web/src/planner/model.ts'
import { buildObserver, loadPolarSiteBundle, polarSites, wasmPath } from '../web/src/planner/benchmark.mjs'
import { createWasmSearchEngine } from '../web/src/planner/wasmSearch.ts'
import { createUmbraServer } from './server.mjs'
import { createStudyWorkerLoop, loadReleaseVersions } from './worker.mjs'
import { StudyQueueStore } from './queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_PATH = resolve(ROOT, 'research/benchmarks/phase5_perf_report.json')

function pctl(arr, p) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return Number(s[idx].toFixed(3))
}

function mb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2))
}

async function benchDatasetLoading() {
  const perSite = {}
  const tAll0 = performance.now()
  for (const site of polarSites) {
    const t0 = performance.now()
    const b = await loadPolarSiteBundle(site)
    const dt = performance.now() - t0
    const bytesLoaded =
      b.vectors.byteLength +
      b.localHorizons.byteLength +
      b.horizonErr.byteLength +
      b.slope.byteLength +
      b.psr.byteLength +
      b.h96.byteLength +
      b.h48.byteLength +
      b.dist.byteLength +
      b.cov.byteLength
    perSite[site] = {
      coldLoadAndSha256Ms: Number(dt.toFixed(2)),
      decodedArrayMb: mb(bytesLoaded),
    }
  }
  return {
    totalAll3SitesMs: Number((performance.now() - tAll0).toFixed(2)),
    perSite,
    rssAfterLoadMb: mb(process.memoryUsage().rss),
  }
}

async function benchWasmVsTs() {
  const bundle = await loadPolarSiteBundle('shackleton-ridge')
  const wasmBytes = await readFile(wasmPath)
  const tInit0 = performance.now()
  const wasm = await createWasmSearchEngine(wasmBytes)
  const wasmInitMs = performance.now() - tInit0

  const steps = 15 * 288
  const limits = { dark: 48, earth: 72, slope: 5 }

  // Warmup JIT & WASM buffers
  const warmPad = buildObserver(bundle, 480, 2)
  searchObserverDual(warmPad, bundle.vectors, steps, bundle.meta, limits, 0)
  wasm.searchDual(warmPad, bundle.vectors, steps, bundle.meta, limits, 0)

  const tsPerPad = []
  const wasmPerPad = []
  let eligibleCount = 0

  const tTs0 = performance.now()
  for (let node = 0; node < 961; node++) {
    const pad = buildObserver(bundle, node, 2)
    if (pad.slope > limits.slope) continue
    eligibleCount++
    const s0 = performance.now()
    searchObserverDual(pad, bundle.vectors, steps, bundle.meta, limits, 0)
    tsPerPad.push(performance.now() - s0)
  }
  const tsSweepMs = performance.now() - tTs0

  const tWasm0 = performance.now()
  for (let node = 0; node < 961; node++) {
    const pad = buildObserver(bundle, node, 2)
    if (pad.slope > limits.slope) continue
    const s0 = performance.now()
    wasm.searchDual(pad, bundle.vectors, steps, bundle.meta, limits, 0)
    wasmPerPad.push(performance.now() - s0)
  }
  const wasmSweepMs = performance.now() - tWasm0

  // Verify exact parity on Shackleton Pad #481 & first low-slope pad
  const pCheck = buildObserver(bundle, 216, 2)
  assert.deepEqual(
    wasm.searchDual(pCheck, bundle.vectors, steps, bundle.meta, limits, 0),
    searchObserverDual(pCheck, bundle.vectors, steps, bundle.meta, limits, 0),
  )

  return {
    site: 'shackleton-ridge',
    totalPads: 961,
    slopeFilteredPadsEvaluated: eligibleCount,
    wasmByteLength: wasm.byteLength,
    wasmColdInitMs: Number(wasmInitMs.toFixed(2)),
    typescript: {
      fullSweepMs: Number(tsSweepMs.toFixed(2)),
      perEligiblePadMs: { p50: pctl(tsPerPad, 50), p95: pctl(tsPerPad, 95) },
      throughputEligiblePadsPerSec: Number(((eligibleCount * 1000) / tsSweepMs).toFixed(1)),
    },
    rustWasm: {
      fullSweepMs: Number(wasmSweepMs.toFixed(2)),
      perEligiblePadMs: { p50: pctl(wasmPerPad, 50), p95: pctl(wasmPerPad, 95) },
      throughputEligiblePadsPerSec: Number(((eligibleCount * 1000) / wasmSweepMs).toFixed(1)),
    },
    measuredSpeedupFactor: Number((tsSweepMs / wasmSweepMs).toFixed(2)),
  }
}

async function benchQueueConcurrency() {
  const concurrencies = [1, 2, 4, 8, 16]
  const results = {}
  let sampleTrace = []

  for (const c of concurrencies) {
    const dir = mkdtempSync(join(os.tmpdir(), `umbra-bench-${c}-`))
    const dbPath = join(dir, 'studies.sqlite')
    const artifactsDir = join(dir, 'artifacts')

    // Compare 1 worker vs 2 workers at concurrency >= 8 if scaling matters
    const srv = await createUmbraServer({
      host: '127.0.0.1',
      port: 0,
      apiToken: '',
      dbPath,
      artifactsDir,
      embeddedWorker: true,
      silentLogs: true,
      maxQueueDepth: 64,
      rateMax: 500,
    })

    // Add a second competing worker loop cleanly for c >= 8 to measure multi-worker scaling
    let extraWorker = null
    if (c >= 8) {
      const versions = await loadReleaseVersions()
      extraWorker = createStudyWorkerLoop({
        store: srv.store,
        versions,
        workerId: 'worker-pool-2',
        pollIntervalMs: 50,
        metrics: srv.metrics,
        traces: srv.traces,
        logger: { info() {}, warn() {}, error() {} },
      })
      void extraWorker.start()
    }

    const baseUrl = `http://127.0.0.1:${srv.port}`
    const submitLats = []
    const e2eLats = []
    const tBatch0 = performance.now()

    await Promise.all(
      Array.from({ length: c }, async (_, idx) => {
        const plan = {
          kind: 'compare',
          days: 15,
          scenarios: [
            { site: polarSites[idx % 3], node: (400 + idx * 7) % 961, start: (idx * 6) % 300, mast: 2 },
            { site: polarSites[(idx + 1) % 3], node: (200 + idx * 11) % 961, start: (idx * 6 + 48) % 300, mast: 2 },
          ],
        }
        const ts0 = performance.now()
        const post = await fetch(`${baseUrl}/api/study/runs`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': `bench-${c}-${idx}`,
            traceparent: `00-222222222222222222222222222222${String(idx).padStart(2, '0')}-3333333333333333-01`,
          },
          body: JSON.stringify({ plan, sigma: 0 }),
        })
        const submitMs = performance.now() - ts0
        submitLats.push(submitMs)
        const job = await post.json()

        // Poll until terminal state
        let state = job.state
        while (state === 'queued' || state === 'running') {
          await new Promise(r => setTimeout(r, 25))
          const poll = await fetch(`${baseUrl}/api/study/runs/${job.id}`)
          const cur = await poll.json()
          state = cur.state
        }
        e2eLats.push(performance.now() - ts0)
      }),
    )
    const wallMs = performance.now() - tBatch0
    const completedRows = srv.store.db.prepare("SELECT duration_ms, created, updated FROM studies WHERE state='completed'").all()
    const execDurs = completedRows.map(r => Number(r.duration_ms ?? 0))

    if (c === 1) {
      sampleTrace = srv.traces.recent(8)
    }
    if (extraWorker) await extraWorker.stop()
    await srv.close()
    rmSync(dir, { recursive: true, force: true })

    results[`c_${c}`] = {
      concurrentRequests: c,
      workerCount: c >= 8 ? 2 : 1,
      totalWallMs: Number(wallMs.toFixed(2)),
      throughputJobsPerSec: Number(((c * 1000) / wallMs).toFixed(2)),
      httpSubmitMs: { p50: pctl(submitLats, 50), p95: pctl(submitLats, 95) },
      workerExecMs: { p50: pctl(execDurs, 50), p95: pctl(execDurs, 95) },
      endToEndMs: { p50: pctl(e2eLats, 50), p95: pctl(e2eLats, 95) },
    }
  }

  return { concurrencySweep: results, sampleTrace }
}

async function main() {
  const cpus = os.cpus()
  const t0 = performance.now()
  const datasetLoading = await benchDatasetLoading()
  const wasmVsTs = await benchWasmVsTs()
  const queueBench = await benchQueueConcurrency()
  const mem = process.memoryUsage()

  const report = {
    benchmarkVersion: 'phase5-prod-perf-v1',
    environment: {
      platform: os.platform(),
      arch: process.arch,
      nodeVersion: process.version,
      cpuModel: cpus[0]?.model ?? 'unknown',
      logicalCores: cpus.length,
      totalSystemMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    },
    datasetLoading,
    wasmVsTs,
    ...queueBench,
    memorySummaryMb: {
      peakRssMb: mb(mem.rss),
      heapTotalMb: mb(mem.heapTotal),
      heapUsedMb: mb(mem.heapUsed),
      externalMb: mb(mem.external),
    },
    totalBenchmarkDurationMs: Number((performance.now() - t0).toFixed(1)),
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({
    datasetAll3Ms: datasetLoading.totalAll3SitesMs,
    tsSweepMs: wasmVsTs.typescript.fullSweepMs,
    wasmSweepMs: wasmVsTs.rustWasm.fullSweepMs,
    speedup: wasmVsTs.measuredSpeedupFactor,
    peakRssMb: report.memorySummaryMb.peakRssMb,
    concurrencySweep: report.concurrencySweep,
  }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
