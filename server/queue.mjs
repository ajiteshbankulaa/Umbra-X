import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'

export class IdempotencyConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IdempotencyConflictError'
    this.statusCode = 409
  }
}

export class QueueOverloadedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QueueOverloadedError'
    this.statusCode = 429
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArtifactIntegrityError'
    this.statusCode = 500
  }
}

const REQUIRED_COLUMNS = [
  ['idempotency_key', 'TEXT'],
  ['updated', 'TEXT'],
  ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
  ['max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
  ['lease_worker_id', 'TEXT'],
  ['lease_expires_at', 'INTEGER'],
  ['heartbeat_at', 'INTEGER'],
  ['cancel_requested', 'INTEGER NOT NULL DEFAULT 0'],
  ['timeout_ms', 'INTEGER NOT NULL DEFAULT 120000'],
  ['artifact_path', 'TEXT'],
  ['artifact_sha256', 'TEXT'],
  ['duration_ms', 'REAL'],
  ['trace_id', 'TEXT'],
]

export class StudyQueueStore {
  constructor({ dbPath, artifactsDir, maxQueueDepth = 32 } = {}) {
    if (!dbPath) throw new Error('dbPath is required.')
    this.dbPath = dbPath
    this.artifactsDir = artifactsDir || resolve(dirname(dbPath), 'artifacts')
    this.maxQueueDepth = maxQueueDepth
    mkdirSync(dirname(dbPath), { recursive: true })
    mkdirSync(this.artifactsDir, { recursive: true })

    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS studies (
        id TEXT PRIMARY KEY,
        fingerprint TEXT UNIQUE NOT NULL,
        created TEXT NOT NULL,
        state TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT,
        error TEXT
      );
    `)
    this._migrateColumns()
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_studies_idempotency
      ON studies(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_studies_state_lease
      ON studies(state, lease_expires_at, created);
    `)
  }

  _migrateColumns() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(studies)').all().map(c => c.name))
    for (const [name, ddl] of REQUIRED_COLUMNS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE studies ADD COLUMN ${name} ${ddl};`)
    }
  }

  _withTx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Ignore rollback errors if connection closing
      }
      throw err
    }
  }

  reclaimExpired(now = Date.now()) {
    return this._withTx(() => {
      const expired = this.db
        .prepare("SELECT id, attempt, max_attempts FROM studies WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
        .all(now)
      let requeued = 0
      let deadLettered = 0
      const iso = new Date(now).toISOString()
      for (const row of expired) {
        if (row.attempt < row.max_attempts) {
          this.db
            .prepare(
              "UPDATE studies SET state='queued', lease_worker_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated=?, error='Worker lease expired; requeued automatically.' WHERE id=? AND state='running'",
            )
            .run(iso, row.id)
          requeued++
        } else {
          this.db
            .prepare(
              "UPDATE studies SET state='failed', lease_worker_id=NULL, lease_expires_at=NULL, updated=?, error='Exceeded max_attempts after worker lease expiry.' WHERE id=? AND state='running'",
            )
            .run(iso, row.id)
          deadLettered++
        }
      }
      return { requeued, deadLettered }
    })
  }

  submitStudy({ input, idempotencyKey = null, maxAttempts = 3, timeoutMs = 120_000, traceId = null, now = Date.now() }) {
    const raw = JSON.stringify(input)
    const fingerprint = createHash('sha256').update(raw).digest('hex')
    const iso = new Date(now).toISOString()
    const cleanKey = idempotencyKey ? String(idempotencyKey).trim().slice(0, 128) : null

    return this._withTx(() => {
      if (cleanKey) {
        const byKey = this.db.prepare('SELECT * FROM studies WHERE idempotency_key=?').get(cleanKey)
        if (byKey) {
          if (byKey.fingerprint !== fingerprint) {
            throw new IdempotencyConflictError('Idempotency-Key was already used for a different study specification.')
          }
          return { row: byKey, reused: true, requeued: false }
        }
      }

      const prior = this.db.prepare('SELECT * FROM studies WHERE fingerprint=?').get(fingerprint)
      if (prior && !['failed', 'canceled'].includes(prior.state)) {
        return { row: prior, reused: true, requeued: false }
      }

      const activeCount = this.db.prepare("SELECT count(*) AS n FROM studies WHERE state IN ('queued','running')").get().n
      if (activeCount >= this.maxQueueDepth) {
        throw new QueueOverloadedError(`Study queue is full (${activeCount}/${this.maxQueueDepth}). Try again shortly.`)
      }

      if (prior) {
        this.db
          .prepare(
            "UPDATE studies SET state='queued', idempotency_key=COALESCE(?, idempotency_key), updated=?, attempt=0, max_attempts=?, lease_worker_id=NULL, lease_expires_at=NULL, heartbeat_at=NULL, cancel_requested=0, timeout_ms=?, result=NULL, artifact_path=NULL, artifact_sha256=NULL, error=NULL, duration_ms=NULL, trace_id=? WHERE id=?",
          )
          .run(cleanKey, iso, maxAttempts, timeoutMs, traceId, prior.id)
        return { row: this.db.prepare('SELECT * FROM studies WHERE id=?').get(prior.id), reused: false, requeued: true }
      }

      const id = randomUUID()
      this.db
        .prepare(
          "INSERT INTO studies (id, fingerprint, idempotency_key, created, updated, state, attempt, max_attempts, cancel_requested, timeout_ms, input, trace_id) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?, ?)",
        )
        .run(id, fingerprint, cleanKey, iso, iso, maxAttempts, timeoutMs, raw, traceId)
      return { row: this.db.prepare('SELECT * FROM studies WHERE id=?').get(id), reused: false, requeued: false }
    })
  }

  claimNextJob(workerId, leaseMs = 15_000, now = Date.now()) {
    this.reclaimExpired(now)
    return this._withTx(() => {
      const next = this.db
        .prepare("SELECT * FROM studies WHERE state='queued' AND cancel_requested=0 ORDER BY created ASC LIMIT 1")
        .get()
      if (!next) return null
      const iso = new Date(now).toISOString()
      const expiresAt = now + leaseMs
      const res = this.db
        .prepare(
          "UPDATE studies SET state='running', attempt=attempt+1, lease_worker_id=?, lease_expires_at=?, heartbeat_at=?, updated=?, error=NULL WHERE id=? AND state='queued'",
        )
        .run(workerId, expiresAt, now, iso, next.id)
      if (!res.changes) return null
      return this.db.prepare('SELECT * FROM studies WHERE id=?').get(next.id)
    })
  }

  renewLease(id, workerId, leaseMs = 15_000, now = Date.now()) {
    const expiresAt = now + leaseMs
    const iso = new Date(now).toISOString()
    const res = this.db
      .prepare(
        "UPDATE studies SET lease_expires_at=?, heartbeat_at=?, updated=? WHERE id=? AND state='running' AND lease_worker_id=?",
      )
      .run(expiresAt, now, iso, id, workerId)
    const row = this.db.prepare('SELECT state, cancel_requested FROM studies WHERE id=?').get(id)
    return {
      ok: Boolean(res.changes),
      cancelRequested: !row || row.cancel_requested === 1 || row.state === 'canceled',
    }
  }

  completeJob({ id, workerId, result, durationMs, now = Date.now() }) {
    const payload = JSON.stringify(result)
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const artifactName = `${id}.json`
    const finalPath = resolve(this.artifactsDir, artifactName)
    const tmpPath = resolve(this.artifactsDir, `${id}.json.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)

    writeFileSync(tmpPath, payload, 'utf8')
    renameSync(tmpPath, finalPath)

    const iso = new Date(now).toISOString()
    const committed = this._withTx(() => {
      const current = this.db.prepare('SELECT state, cancel_requested, lease_worker_id FROM studies WHERE id=?').get(id)
      if (!current || current.state !== 'running' || current.lease_worker_id !== workerId || current.cancel_requested === 1) {
        return false
      }
      this.db
        .prepare(
          "UPDATE studies SET state='completed', lease_worker_id=NULL, lease_expires_at=NULL, updated=?, result=?, artifact_path=?, artifact_sha256=?, duration_ms=?, error=NULL WHERE id=?",
        )
        .run(iso, payload, artifactName, sha256, Number(durationMs.toFixed(2)), id)
      return true
    })

    if (!committed && existsSync(finalPath)) {
      try {
        unlinkSync(finalPath)
      } catch {
        // Ignore best-effort cleanup
      }
    }
    return { committed, artifactSha256: sha256, artifactPath: artifactName }
  }

  failJob({ id, workerId, error, retryable = false, now = Date.now() }) {
    const iso = new Date(now).toISOString()
    const msg = String(error ?? 'Worker execution failed.').slice(0, 1000)
    return this._withTx(() => {
      const current = this.db.prepare('SELECT state, attempt, max_attempts, lease_worker_id, cancel_requested FROM studies WHERE id=?').get(id)
      if (!current || current.state !== 'running' || current.lease_worker_id !== workerId) return { state: current?.state ?? 'missing' }
      if (current.cancel_requested === 1) {
        this.db
          .prepare("UPDATE studies SET state='canceled', lease_worker_id=NULL, lease_expires_at=NULL, updated=?, error=NULL WHERE id=?")
          .run(iso, id)
        return { state: 'canceled', willRetry: false }
      }
      if (retryable && current.attempt < current.max_attempts) {
        this.db
          .prepare("UPDATE studies SET state='queued', lease_worker_id=NULL, lease_expires_at=NULL, updated=?, error=? WHERE id=?")
          .run(iso, msg, id)
        return { state: 'queued', willRetry: true }
      }
      this.db
        .prepare("UPDATE studies SET state='failed', lease_worker_id=NULL, lease_expires_at=NULL, updated=?, error=? WHERE id=?")
        .run(iso, msg, id)
      return { state: 'failed', willRetry: false }
    })
  }

  cancelJob(id, now = Date.now()) {
    const iso = new Date(now).toISOString()
    return this._withTx(() => {
      const row = this.db.prepare('SELECT * FROM studies WHERE id=?').get(id)
      if (!row) return null
      if (row.state === 'queued') {
        this.db
          .prepare("UPDATE studies SET state='canceled', cancel_requested=1, updated=? WHERE id=?")
          .run(iso, id)
      } else if (row.state === 'running') {
        this.db
          .prepare('UPDATE studies SET cancel_requested=1, updated=? WHERE id=?')
          .run(iso, id)
      }
      return this.db.prepare('SELECT * FROM studies WHERE id=?').get(id)
    })
  }

  markCanceledIfRequested(id, workerId, now = Date.now()) {
    const iso = new Date(now).toISOString()
    return this.db
      .prepare("UPDATE studies SET state='canceled', lease_worker_id=NULL, lease_expires_at=NULL, updated=? WHERE id=? AND lease_worker_id=? AND cancel_requested=1")
      .run(iso, id, workerId).changes > 0
  }

  getById(id) {
    return this.db.prepare('SELECT * FROM studies WHERE id=?').get(id) ?? null
  }

  readVerifiedResult(row) {
    if (!row) return null
    if (row.artifact_path) {
      const fullPath = resolve(this.artifactsDir, row.artifact_path)
      if (!fullPath.startsWith(this.artifactsDir)) {
        throw new ArtifactIntegrityError('Invalid artifact path outside artifact store.')
      }
      if (!existsSync(fullPath)) {
        throw new ArtifactIntegrityError(`Committed scientific artifact missing on disk (${row.artifact_path}).`)
      }
      const bytes = readFileSync(fullPath)
      const actualHash = createHash('sha256').update(bytes).digest('hex')
      if (row.artifact_sha256 && actualHash !== row.artifact_sha256) {
        throw new ArtifactIntegrityError(
          `Artifact SHA-256 verification failed for study ${row.id}: expected ${row.artifact_sha256}, got ${actualHash}.`,
        )
      }
      return JSON.parse(bytes.toString('utf8'))
    }
    return row.result ? JSON.parse(row.result) : null
  }

  cleanupStaleTempFiles(maxAgeMs = 60_000, now = Date.now()) {
    let removed = 0
    for (const file of readdirSync(this.artifactsDir)) {
      if (!file.includes('.tmp-')) continue
      const full = resolve(this.artifactsDir, file)
      try {
        if (now - statSync(full).mtimeMs >= maxAgeMs) {
          unlinkSync(full)
          removed++
        }
      } catch {
        // Ignore concurrent cleanup
      }
    }
    return removed
  }

  queueDepthByState() {
    const rows = this.db.prepare('SELECT state, count(*) AS n FROM studies GROUP BY state').all()
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, canceled: 0 }
    for (const r of rows) counts[r.state] = r.n
    return counts
  }

  view(row, activeProgress = null) {
    const result = row.state === 'completed' ? this.readVerifiedResult(row) : null
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      idempotencyKey: row.idempotency_key ?? null,
      state: row.state,
      attempt: row.attempt ?? 0,
      maxAttempts: row.max_attempts ?? 3,
      cancelRequested: row.cancel_requested === 1,
      created: row.created,
      updated: row.updated ?? row.created,
      durationMs: row.duration_ms ?? null,
      artifactSha256: row.artifact_sha256 ?? null,
      traceId: row.trace_id ?? null,
      input: JSON.parse(row.input),
      result,
      error: row.error ?? null,
      progress: row.state === 'running' ? activeProgress : null,
    }
  }

  close() {
    this.db.close()
  }
}
