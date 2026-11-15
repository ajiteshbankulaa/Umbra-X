import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { horizonEpoch, mastHeights, validatePlan } from './study.mjs'
import { planWithAgent, providerFromEnv } from './agent.mjs'

const root = new URL('../web/public/data/planner-release/', import.meta.url)
const sites = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']
const dataset = await Promise.all(sites.map(async site => {
  const manifest = JSON.parse(await readFile(new URL(site + '/planner.json', root), 'utf8'))
  if (manifest.start !== '2026-11-14T00:00:00+00:00' || manifest.count !== 8641 || manifest.stepMinutes !== 5 || !manifest.regional)
    throw new Error(`Unexpected release metadata for ${site}.`)
  return [site, manifest]
}))
const versions = Object.fromEntries(dataset)
const release = createHash('sha256').update(JSON.stringify(versions)).digest('hex')
const solver = createHash('sha256')
for (const name of ['./study.mjs', '../web/src/planner/model.ts', '../web/public/wasm/umbra_core.wasm'])
  solver.update(await readFile(new URL(name, import.meta.url)))
const solverVersion = solver.digest('hex')
const dbPath = resolve(process.env.UMBRA_STUDY_DB || fileURLToPath(new URL('./state/studies.sqlite', import.meta.url)))
await mkdir(dirname(dbPath), { recursive: true })
const db = new DatabaseSync(dbPath)
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS studies (
    id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, created TEXT NOT NULL,
    state TEXT NOT NULL, input TEXT NOT NULL, result TEXT, error TEXT
  );
  UPDATE studies SET state='queued' WHERE state='running';`)
const provider = providerFromEnv()
const coverage = { epoch: horizonEpoch, hours: 720, maxDays: 15, mastHeights,
  sites: sites.map(site => ({ site, pads: 961, horizonKm: [48, 96], terrainSource: versions[site].regional.source })),
  ephemeris: 'JPL DE440; checked against JPL Horizons', release, modelConfigured: Boolean(provider) }
const get = db.prepare('SELECT * FROM studies WHERE id=?')
let running
let modelRequests = 0

function pump() {
  if (running) return
  const job = db.prepare("SELECT * FROM studies WHERE state='queued' ORDER BY created LIMIT 1").get()
  if (!job) return
  const input = JSON.parse(job.input)
  if (input.release !== release || input.solver !== solverVersion) {
    db.prepare("UPDATE studies SET state='failed', error=? WHERE id=?").run('Data or solver version changed before execution.', job.id)
    queueMicrotask(pump)
    return
  }
  db.prepare("UPDATE studies SET state='running' WHERE id=?").run(job.id)
  const worker = new Worker(new URL('./study.mjs', import.meta.url), { workerData: { ...input, versions } })
  const active = { id: job.id, worker, progress: null }
  running = active
  const finish = (state, result, error) => {
    if (running !== active) return
    db.prepare('UPDATE studies SET state=?, result=?, error=? WHERE id=?')
      .run(state, result ? JSON.stringify(result) : null, error ?? null, job.id)
    running = undefined
    void worker.terminate()
    pump()
  }
  worker.on('message', event => {
    if (event.progress) active.progress = event.progress
    else if (event.error) finish('failed', null, event.error)
    else finish('completed', event.result)
  })
  worker.on('error', error => finish('failed', null, error.message))
  worker.on('exit', () => finish('failed', null, 'Study worker stopped before returning a result.'))
  active.cancel = () => finish('canceled', null, null)
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 8192) throw new Error('Request exceeds 8 KB.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

function view(row) {
  return { id: row.id, state: row.state, created: row.created, input: JSON.parse(row.input),
    result: row.result ? JSON.parse(row.result) : null, error: row.error,
    progress: running?.id === row.id ? running.progress : null }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const origin = req.headers.origin
  const localPreview = /^http:\/\/(?:127\.0\.0\.1|localhost):(?:5174|5173|4173)$/.test(origin ?? '')
  if (origin && !localPreview && ![`http://${req.headers.host}`, `https://${req.headers.host}`, process.env.UMBRA_WEB_ORIGIN].includes(origin))
    return send(res, 403, { error: 'Origin is outside the configured planner.' })
  try {
    if (req.method === 'GET' && path === '/api/study/coverage') return send(res, 200, coverage)
    if (req.method === 'POST' && path === '/api/study/interpret') {
      if (!provider) return send(res, 503, { error: 'Model provider is not configured.' })
      if (modelRequests >= 2) return send(res, 429, { error: 'The agent is busy.' })
      const { question, context } = await readBody(req)
      if (typeof question !== 'string' || !question.trim() || question.length > 500)
        throw new Error('Enter a question of up to 500 characters.')
      modelRequests++
      try {
        const answer = await planWithAgent(question, context, coverage, provider, AbortSignal.timeout(25000))
        return send(res, 200, answer)
      } catch (error) {
        return send(res, 502, { error: error.message })
      } finally { modelRequests-- }
    }
    if (req.method === 'POST' && path === '/api/study/runs') {
      const body = await readBody(req)
      const plan = validatePlan(body.plan)
      const sigma = body.sigma ?? 0
      if (!Number.isFinite(sigma) || sigma < 0 || sigma > 3) throw new Error('Local error multiplier must be between 0 and 3.')
      const input = { plan, power: { sigma }, release, solver: solverVersion }
      const raw = JSON.stringify(input)
      const key = createHash('sha256').update(raw).digest('hex')
      const prior = db.prepare('SELECT * FROM studies WHERE fingerprint=?').get(key)
      if (prior && !['failed', 'canceled'].includes(prior.state)) return send(res, 200, { ...view(prior), reused: true })
      if (db.prepare("SELECT count(*) AS n FROM studies WHERE state IN ('queued','running')").get().n >= 8)
        return send(res, 429, { error: 'Study queue is full. Try again shortly.' })
      if (prior) {
        db.prepare("UPDATE studies SET state='queued', result=NULL, error=NULL WHERE id=?").run(prior.id)
      } else {
        db.prepare("INSERT INTO studies (id,fingerprint,created,state,input) VALUES (?,?,?,'queued',?)")
          .run(randomUUID(), key, new Date().toISOString(), raw)
      }
      const row = db.prepare('SELECT * FROM studies WHERE fingerprint=?').get(key)
      send(res, 202, view(row))
      pump()
      return
    }
    const id = path.match(/^\/api\/study\/runs\/([a-f0-9-]{36})$/)?.[1]
    const row = id && get.get(id)
    if (row && req.method === 'GET') return send(res, 200, view(row))
    if (row && req.method === 'DELETE') {
      db.prepare("UPDATE studies SET state='canceled' WHERE id=? AND state='queued'").run(id)
      if (running?.id === id) running.cancel()
      return send(res, 200, view(get.get(id)))
    }
    send(res, 404, { error: 'Study endpoint or run not found.' })
  } catch (error) {
    if (!res.headersSent) send(res, 400, { error: error.message })
  }
})
server.listen(Number(process.env.UMBRA_PORT || 8787), '127.0.0.1', () => {
  console.log(`Umbra-X study API on http://127.0.0.1:${server.address().port} · model ${provider ? 'configured' : 'off'}`)
  pump()
})
