import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudyQueueStore, ArtifactIntegrityError, IdempotencyConflictError } from './queue.mjs'
import { createStudyWorkerLoop, loadReleaseVersions } from './worker.mjs'
import { createUmbraServer } from './server.mjs'
import { assertSafeBindConfig, checkBearerAuth } from './security.mjs'

const validPlan = {
  kind: 'compare',
  days: 1,
  scenarios: [
    { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
  ],
}

function makeTempState() {
  const dir = mkdtempSync(join(tmpdir(), 'umbra-p5-'))
  return {
    dir,
    dbPath: join(dir, 'studies.sqlite'),
    artifactsDir: join(dir, 'artifacts'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('queue recovers crashed worker lease, cleans partial tmp artifacts, and verifies SHA-256 on completion', async () => {
  const tmp = makeTempState()
  try {
    const store = new StudyQueueStore({ dbPath: tmp.dbPath, artifactsDir: tmp.artifactsDir })
    const versions = await loadReleaseVersions()
    const input = { plan: validPlan, power: { sigma: 0 }, release: 'rel-1', solver: 'solv-1' }
    const { row } = store.submitStudy({ input, maxAttempts: 3, traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    assert.equal(row.state, 'queued')

    // Worker A claims short 80 ms lease and crashes, leaving an orphaned .tmp file
    const claimedA = store.claimNextJob('worker-dead-A', 80)
    assert.equal(claimedA.state, 'running')
    assert.equal(claimedA.attempt, 1)
    const orphanTmp = join(tmp.artifactsDir, `${row.id}.json.tmp-99999-crash`)
    writeFileSync(orphanTmp, '{"partial": true', 'utf8')
    assert.equal(existsSync(orphanTmp), true)

    await new Promise(r => setTimeout(r, 120))

    // Worker B starts up cleanly: cleans temp file, reclaims expired lease, and executes to completion
    const workerB = createStudyWorkerLoop({
      store,
      versions,
      workerId: 'worker-live-B',
      leaseMs: 10_000,
      logger: { info() {}, warn() {}, error() {} },
    })
    store.cleanupStaleTempFiles(0)
    assert.equal(existsSync(orphanTmp), false)

    const processed = await workerB.processOnce()
    assert.equal(processed, true)

    const done = store.getById(row.id)
    assert.equal(done.state, 'completed')
    assert.equal(done.attempt, 2)
    assert.match(done.artifact_sha256, /^[a-f0-9]{64}$/)
    const parsed = store.readVerifiedResult(done)
    assert.equal(parsed.comparisons.length, 2)

    // Exhausting max_attempts moves job cleanly to failed instead of infinite loop
    const { row: row2 } = store.submitStudy({ input: { ...input, power: { sigma: 1 } }, maxAttempts: 1 })
    store.claimNextJob('worker-dead-C', 40)
    await new Promise(r => setTimeout(r, 60))
    const reclaimed = store.reclaimExpired()
    assert.equal(reclaimed.deadLettered, 1)
    assert.equal(store.getById(row2.id).state, 'failed')
    assert.match(store.getById(row2.id).error, /max_attempts/)

    store.close()
  } finally {
    tmp.cleanup()
  }
})

test('artifact corruption is detected by SHA-256 check on read', () => {
  const tmp = makeTempState()
  try {
    const store = new StudyQueueStore({ dbPath: tmp.dbPath, artifactsDir: tmp.artifactsDir })
    const { row } = store.submitStudy({ input: { plan: validPlan, power: { sigma: 0 }, release: 'r', solver: 's' } })
    const claimed = store.claimNextJob('w1', 5000)
    store.completeJob({ id: claimed.id, workerId: 'w1', result: { comparisons: [1, 2] }, durationMs: 12.3 })

    // Corrupt committed artifact on disk
    const artFile = join(tmp.artifactsDir, `${row.id}.json`)
    const orig = readFileSync(artFile, 'utf8')
    writeFileSync(artFile, orig.replace('1', '9'), 'utf8')

    assert.throws(() => store.readVerifiedResult(store.getById(row.id)), ArtifactIntegrityError)
    store.close()
  } finally {
    tmp.cleanup()
  }
})

test('cancellation prevents late worker completion from reviving canceled study', () => {
  const tmp = makeTempState()
  try {
    const store = new StudyQueueStore({ dbPath: tmp.dbPath, artifactsDir: tmp.artifactsDir })
    const { row } = store.submitStudy({ input: { plan: validPlan, power: { sigma: 0 }, release: 'r', solver: 's' } })
    const claimed = store.claimNextJob('w1', 5000)
    const cancelRes = store.cancelJob(claimed.id)
    assert.equal(cancelRes.cancel_requested, 1)

    const hb = store.renewLease(claimed.id, 'w1', 5000)
    assert.equal(hb.cancelRequested, true)

    const lateCommit = store.completeJob({ id: claimed.id, workerId: 'w1', result: { ok: true }, durationMs: 5 })
    assert.equal(lateCommit.committed, false)
    assert.equal(existsSync(join(tmp.artifactsDir, `${row.id}.json`)), false)

    store.markCanceledIfRequested(claimed.id, 'w1')
    assert.equal(store.getById(row.id).state, 'canceled')
    store.close()
  } finally {
    tmp.cleanup()
  }
})

test('security checks refuse non-loopback weak tokens, enforce bearer auth, rate limit, and safe JSON parsing', async () => {
  assert.throws(() => assertSafeBindConfig('0.0.0.0', ''), /Refusing to bind/)
  assert.throws(() => assertSafeBindConfig('0.0.0.0', 'changeme-short'), /Refusing to bind/)
  assert.doesNotThrow(() => assertSafeBindConfig('0.0.0.0', 'umbra_prod_token_9f8e7d6c5b4a3210'))
  assert.equal(checkBearerAuth({ headers: {} }, 'abc').ok, false)

  const tmp = makeTempState()
  const token = 'test_umbra_secret_token_9876543210abcdef'
  const srv = await createUmbraServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: token,
    dbPath: tmp.dbPath,
    artifactsDir: tmp.artifactsDir,
    embeddedWorker: true,
    silentLogs: true,
    rateMax: 18,
    usePythonQdrant: false,
  })
  const baseUrl = `http://127.0.0.1:${srv.port}`

  try {
    // Public read endpoints work cleanly
    const hz = await fetch(`${baseUrl}/healthz`)
    assert.equal(hz.status, 200)
    const rz = await fetch(`${baseUrl}/readyz`)
    assert.equal(rz.status, 200)

    // Unauthenticated POST /api/study/runs -> 401
    const unauth = await fetch(`${baseUrl}/api/study/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: validPlan }),
    })
    assert.equal(unauth.status, 401)

    // Bad CORS origin -> 403
    const badOrigin = await fetch(`${baseUrl}/api/study/coverage`, {
      headers: { origin: 'https://evil.example.com' },
    })
    assert.equal(badOrigin.status, 403)

    // Prototype pollution key rejected -> 400
    const protoPollute = await fetch(`${baseUrl}/api/study/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"plan":{"kind":"compare"},"__proto__":{"polluted":true}}',
    })
    assert.equal(protoPollute.status, 400)

    // Concurrent idempotent submission -> 1 created (202), rest reused (200)
    const idemKey = 'idem-concurrent-001'
    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': idemKey,
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    }
    const burst = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${baseUrl}/api/study/runs`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ plan: validPlan, sigma: 0 }),
        }),
      ),
    )
    const bodies = await Promise.all(burst.map(r => r.json()))
    const ids = new Set(bodies.map(b => b.id))
    assert.equal(ids.size, 1)

    // Conflicting Idempotency-Key payload -> 409 Conflict
    const conflict = await fetch(`${baseUrl}/api/study/runs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ plan: { ...validPlan, days: 2 }, sigma: 0 }),
    })
    assert.equal(conflict.status, 409)

    // Client telemetry endpoint records WASM fallback & worker timing
    const tel = await fetch(`${baseUrl}/api/telemetry/client`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'wasm_fallback', engine: 'TypeScript', elapsedMs: 42.5 }),
    })
    assert.equal(tel.status, 202)

    // Prometheus /metrics & traces work and never leak Bearer token
    const metricsRes = await fetch(`${baseUrl}/metrics`)
    assert.equal(metricsRes.status, 200)
    const metricsText = await metricsRes.text()
    assert.match(metricsText, /umbrax_http_requests_total/)
    assert.match(metricsText, /umbrax_wasm_fallbacks_total 1/)
    assert.equal(metricsText.includes(token), false)

    const traceRes = await fetch(`${baseUrl}/api/telemetry/traces`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(traceRes.status, 200)
    const traceJson = await traceRes.json()
    assert.ok(traceJson.spans.some(s => s.traceId === '11111111111111111111111111111111'))
    assert.equal(JSON.stringify(traceJson).includes(token), false)

    // Rate limit exhaustion triggers 429 + Retry-After
    let got429 = false
    for (let i = 0; i < 10; i++) {
      const rl = await fetch(`${baseUrl}/api/study/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan: validPlan, sigma: 0 }),
      })
      if (rl.status === 429) {
        got429 = true
        assert.ok(Number(rl.headers.get('retry-after')) >= 1)
        break
      }
    }
    assert.equal(got429, true)
  } finally {
    await srv.close()
    tmp.cleanup()
  }
})

test('server proxies /api/polar-horizon and /api/horizon to upstream terrain service and validates bounds', async () => {
  const tmp = makeTempState()
  const mockTerrain = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/api/polar-horizon') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ lat: Number(u.searchParams.get('lat')), lon: Number(u.searchParams.get('lon')), mast_m: 5, complete: true, covered_azimuths: 360 }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => mockTerrain.listen(0, '127.0.0.1', resolve))
  const terrainPort = mockTerrain.address().port

  const srv = await createUmbraServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: tmp.dbPath,
    artifactsDir: tmp.artifactsDir,
    embeddedWorker: false,
    silentLogs: true,
    terrainUrl: `http://127.0.0.1:${terrainPort}`,
    usePythonQdrant: false,
  })
  const baseUrl = `http://127.0.0.1:${srv.port}`

  try {
    const ok1 = await fetch(`${baseUrl}/api/polar-horizon?lat=-88.5&lon=45&mast=5`)
    assert.equal(ok1.status, 200)
    assert.equal((await ok1.json()).covered_azimuths, 360)

    const ok2 = await fetch(`${baseUrl}/api/horizon?lat=-88.5&lon=45&mast=5`)
    assert.equal(ok2.status, 200)
    assert.equal((await ok2.json()).lat, -88.5)

    const bad = await fetch(`${baseUrl}/api/polar-horizon?lat=-75&lon=45&mast=5`)
    assert.equal(bad.status, 400)
  } finally {
    await srv.close()
    mockTerrain.close()
    tmp.cleanup()
  }
})
