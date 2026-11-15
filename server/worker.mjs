import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { StudyQueueStore } from './queue.mjs'
import { createLogger, MetricsRegistry, TraceRecorder } from './telemetry.mjs'

const SITES = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']

export async function loadReleaseVersions() {
  const root = new URL('../web/public/data/planner-release/', import.meta.url)
  const dataset = await Promise.all(
    SITES.map(async site => [site, JSON.parse(await readFile(new URL(site + '/planner.json', root), 'utf8'))]),
  )
  return Object.fromEntries(dataset)
}

export function createStudyWorkerLoop({
  store,
  versions,
  workerId = `worker-${process.pid}-${randomUUID().slice(0, 6)}`,
  leaseMs = Number(process.env.UMBRA_WORKER_LEASE_MS || 15_000),
  pollIntervalMs = 250,
  metrics = new MetricsRegistry(),
  traces = new TraceRecorder(workerId),
  logger = createLogger({ service: workerId }),
  studyModuleUrl = new URL('./study.mjs', import.meta.url),
} = {}) {
  let stopped = false
  let activeTimer = null
  let activeChild = null
  let activeJobId = null
  let latestProgress = null

  function runJob(job) {
    const input = JSON.parse(job.input)
    const span = traces.startSpan('study.execute', {
      traceId: job.trace_id,
      attributes: { jobId: job.id, kind: input.plan?.kind, attempt: job.attempt, workerId },
    })

    return new Promise(resolveDone => {
      const t0 = performance.now()
      const child = new Worker(studyModuleUrl, { workerData: { ...input, versions } })
      activeChild = child
      activeJobId = job.id
      latestProgress = null
      let settled = false

      const hbMs = Math.max(100, Math.floor(leaseMs / 3))
      const heartbeatTimer = setInterval(() => {
        if (settled) return
        const lease = store.renewLease(job.id, workerId, leaseMs)
        if (!lease.ok || lease.cancelRequested) {
          store.markCanceledIfRequested(job.id, workerId)
          finalize('canceled', null, null)
        }
      }, hbMs)

      const timeoutMs = job.timeout_ms || 120_000
      const timeoutTimer = setTimeout(() => {
        finalize('timeout', null, `Study exceeded execution timeout (${timeoutMs} ms).`)
      }, timeoutMs)

      const finalize = (outcome, result, errorMsg) => {
        if (settled) return
        settled = true
        clearInterval(heartbeatTimer)
        clearTimeout(timeoutTimer)
        activeChild = null
        activeJobId = null
        latestProgress = null
        void child.terminate()
        const durationMs = performance.now() - t0

        if (outcome === 'completed') {
          const { committed, artifactSha256 } = store.completeJob({
            id: job.id,
            workerId,
            result,
            durationMs,
          })
          metrics.incCounter('umbrax_study_jobs_total', 'Total executed study jobs by terminal status', {
            status: committed ? 'completed' : 'canceled',
            kind: input.plan?.kind ?? 'unknown',
          })
          metrics.observeHistogram('umbrax_study_job_duration_ms', 'Study job execution latency in ms', {
            kind: input.plan?.kind ?? 'unknown',
          }, durationMs)
          span.end({ status: 'OK', extraAttributes: { committed, artifactSha256, durationMs: Number(durationMs.toFixed(1)) } })
          logger.info('Study job completed', {
            traceId: job.trace_id,
            jobId: job.id,
            attempt: job.attempt,
            durationMs: Number(durationMs.toFixed(1)),
            artifactSha256,
          })
        } else if (outcome === 'canceled') {
          store.markCanceledIfRequested(job.id, workerId)
          metrics.incCounter('umbrax_study_jobs_total', 'Total executed study jobs by terminal status', {
            status: 'canceled',
            kind: input.plan?.kind ?? 'unknown',
          })
          span.end({ status: 'OK', extraAttributes: { canceled: true } })
          logger.info('Study job canceled cleanly', { traceId: job.trace_id, jobId: job.id, attempt: job.attempt })
        } else {
          const retryable = outcome === 'worker_crash'
          const failRes = store.failJob({ id: job.id, workerId, error: errorMsg, retryable })
          if (failRes.willRetry) {
            metrics.incCounter('umbrax_study_job_retries_total', 'Total study job retry transitions', {
              kind: input.plan?.kind ?? 'unknown',
            })
          }
          metrics.incCounter('umbrax_study_jobs_total', 'Total executed study jobs by terminal status', {
            status: failRes.state,
            kind: input.plan?.kind ?? 'unknown',
          })
          span.end({ status: 'ERROR', error: errorMsg })
          logger.error('Study job failed', {
            traceId: job.trace_id,
            jobId: job.id,
            attempt: job.attempt,
            outcome,
            willRetry: Boolean(failRes.willRetry),
            error: errorMsg,
          })
        }
        resolveDone()
      }

      child.on('message', evt => {
        if (evt.progress) latestProgress = evt.progress
        else if (evt.error) finalize('error', null, evt.error)
        else finalize('completed', evt.result, null)
      })
      child.on('error', err => finalize('worker_crash', null, err.message))
      child.on('exit', code => {
        if (!settled) finalize('worker_crash', null, `Worker thread exited prematurely with code ${code}.`)
      })
    })
  }

  async function processOnce() {
    if (stopped) return false
    const depths = store.queueDepthByState()
    for (const [state, val] of Object.entries(depths)) {
      metrics.setGauge('umbrax_study_queue_depth', 'Current number of studies in each lifecycle state', { state }, val)
    }
    const job = store.claimNextJob(workerId, leaseMs)
    if (!job) return false
    await runJob(job)
    return true
  }

  async function loop() {
    while (!stopped) {
      try {
        const worked = await processOnce()
        if (stopped) break
        if (!worked) {
          await new Promise(r => {
            activeTimer = setTimeout(r, pollIntervalMs)
          })
        }
      } catch (err) {
        logger.error('Worker loop tick error', { error: err.message })
        await new Promise(r => setTimeout(r, pollIntervalMs))
      }
    }
  }

  return {
    workerId,
    start: () => {
      stopped = false
      store.cleanupStaleTempFiles(0)
      return loop()
    },
    processOnce,
    getActiveProgress: id => (activeJobId === id ? latestProgress : null),
    stop: async () => {
      stopped = true
      if (activeTimer) clearTimeout(activeTimer)
      if (activeChild) await activeChild.terminate()
    },
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const dbPath = resolve(process.env.UMBRA_STUDY_DB || fileURLToPath(new URL('./state/studies.sqlite', import.meta.url)))
  const artifactsDir = resolve(process.env.UMBRA_ARTIFACTS_DIR || fileURLToPath(new URL('./state/artifacts', import.meta.url)))
  const store = new StudyQueueStore({ dbPath, artifactsDir })
  const versions = await loadReleaseVersions()
  const worker = createStudyWorkerLoop({ store, versions })
  worker.start()

  const shutdown = async sig => {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service: worker.workerId, msg: `Shutting down on ${sig}` }))
    await worker.stop()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
