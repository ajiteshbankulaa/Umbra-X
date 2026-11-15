import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CHUNKS_PATH = resolve(ROOT, 'research/rag/corpus_chunks.json')
const PYTHON_EXE = resolve(ROOT, '.venv/Scripts/python.exe')
const PYTHON_EXE_POSIX = resolve(ROOT, '.venv/bin/python')
const RETRIEVER_PY = resolve(ROOT, 'research/rag/retriever.py')

const INJECTION_PATTERNS = [
  /ignore (?:all |any )?(?:previous|prior|above) (?:instructions|rules|constraints)/i,
  /override (?:validation|constraints|limits|safety)/i,
  /certify (?:(?:this|the)\s+)?(?:pad|site|mission) as (?:safe|passing|viable)/i,
  /system prompt|developer message|you must (?:now )?say/i,
  /<\s*script|javascript:/i,
]

export function detectPromptInjection(text) {
  if (typeof text !== 'string' || !text) return []
  return INJECTION_PATTERNS.filter(re => re.test(text)).map(re => re.source)
}

export function sanitizePassageText(text) {
  const hits = detectPromptInjection(text)
  if (!hits.length) return { text, injectionFlags: [] }
  let sanitized = String(text)
  for (const re of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(re.source, 'gi'), '[UNTRUSTED_DIRECTIVE_STRIPPED]')
  }
  return { text: sanitized, injectionFlags: hits }
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'what', 'when',
  'where', 'which', 'how', 'does', 'can', 'into', 'over', 'than', 'then',
])

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 2 && !STOPWORDS.has(t))
}

/** Deterministic in-process BM25 fallback when Qdrant/Python helper is unavailable or disabled. */
class JsBm25Fallback {
  constructor(chunks) {
    this.chunks = chunks
    this.k1 = 1.5
    this.b = 0.75
    this.tfs = []
    this.lens = []
    const df = new Map()
    for (const c of chunks) {
      const toks = tokenize(`${c.title} ${c.text}`)
      this.lens.push(toks.length)
      const tf = new Map()
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
      this.tfs.push(tf)
      for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
    }
    this.avgLen = this.lens.reduce((a, b) => a + b, 0) / Math.max(1, chunks.length)
    this.idf = new Map()
    for (const [term, freq] of df) {
      this.idf.set(term, Math.log(1 + (chunks.length - freq + 0.5) / (freq + 0.5)))
    }
  }

  search(query, topK = 5) {
    const t0 = performance.now()
    const qTerms = tokenize(query)
    const scored = []
    for (let i = 0; i < this.chunks.length; i++) {
      const tf = this.tfs[i]
      const normLen = this.k1 * (1 - this.b + (this.b * this.lens[i]) / Math.max(1e-9, this.avgLen))
      let s = 0
      for (const term of qTerms) {
        const f = tf.get(term) ?? 0
        if (!f) continue
        s += (this.idf.get(term) ?? 0) * ((f * (this.k1 + 1)) / (f + normLen))
      }
      if (s > 0) scored.push({ idx: i, score: s })
    }
    scored.sort((a, b) => b.score - a.score)
    const results = scored.slice(0, topK).map(({ idx, score }) => {
      const c = this.chunks[idx]
      const clean = sanitizePassageText(c.text)
      return {
        passageId: c.passageId,
        docId: c.docId,
        title: c.title,
        sectionTitle: c.sectionTitle,
        citation: c.citation,
        sourceUrl: c.sourceUrl,
        contentSha256: c.contentSha256,
        retrievedAt: c.retrievedAt,
        score: Number(score.toFixed(6)),
        scoreDetail: { bm25_js: Number(score.toFixed(4)) },
        injectionFlags: clean.injectionFlags,
        text: clean.text,
      }
    })
    return {
      query,
      mode: 'bm25_js_fallback',
      embeddingModel: 'none (lexical fallback)',
      vectorStore: 'in_memory_bm25',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      results,
    }
  }
}

export class ResearchCorpusRetriever {
  constructor(options = {}) {
    this.usePythonQdrant = options.usePythonQdrant ?? process.env.UMBRA_DISABLE_PYTHON_RAG !== '1'
    this.cache = new Map()
    this.maxCache = options.maxCache ?? 128
    this.proc = null
    this.readyPromise = null
    this.pending = new Map()
    this.nextId = 1

    if (existsSync(CHUNKS_PATH)) {
      const bundle = JSON.parse(readFileSync(CHUNKS_PATH, 'utf8'))
      this.corpusMeta = {
        manifestVersion: bundle.manifestVersion,
        embeddingModel: bundle.embeddingModel,
        chunkCount: bundle.chunkCount,
      }
      this.fallback = new JsBm25Fallback(bundle.chunks)
    } else {
      this.corpusMeta = { manifestVersion: 'missing', embeddingModel: 'none', chunkCount: 0 }
      this.fallback = new JsBm25Fallback([])
    }
  }

  _pythonPath() {
    if (existsSync(PYTHON_EXE)) return PYTHON_EXE
    if (existsSync(PYTHON_EXE_POSIX)) return PYTHON_EXE_POSIX
    return null
  }

  async _ensureWorker() {
    if (this.proc && !this.proc.killed) return this.readyPromise
    const py = this._pythonPath()
    if (!py || !existsSync(RETRIEVER_PY)) return null

    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      const proc = spawn(py, [RETRIEVER_PY, '--serve-stdio'], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.proc = proc
      const rl = createInterface({ input: proc.stdout })
      let booted = false
      const timer = setTimeout(() => {
        if (!booted) rejectReady(new Error('Qdrant retriever worker startup timed out.'))
      }, 20000)

      rl.on('line', line => {
        if (!line.trim()) return
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (!booted && msg.ready) {
          booted = true
          clearTimeout(timer)
          resolveReady(proc)
          return
        }
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.ok) entry.resolve(msg)
        else entry.reject(new Error(msg.error ?? 'Retriever query error'))
      })

      proc.on('exit', () => {
        clearTimeout(timer)
        for (const entry of this.pending.values()) entry.reject(new Error('Retriever worker exited.'))
        this.pending.clear()
        this.proc = null
        if (!booted) rejectReady(new Error('Qdrant retriever failed to start.'))
      })
    })
    return this.readyPromise
  }

  async search(query, { mode = 'hybrid_rrf', topK = 5 } = {}) {
    const normalizedKey = `${mode}|${topK}|${String(query).trim().toLowerCase()}`
    if (this.cache.has(normalizedKey)) {
      return { ...this.cache.get(normalizedKey), cacheHit: true }
    }

    let out
    if (this.usePythonQdrant && mode !== 'bm25_js_fallback') {
      try {
        const proc = await this._ensureWorker()
        if (proc) {
          const id = this.nextId++
          const raw = await new Promise((resolveReq, rejectReq) => {
            const t = setTimeout(() => {
              this.pending.delete(id)
              rejectReq(new Error('Qdrant query timeout'))
            }, 8000)
            this.pending.set(id, {
              resolve: v => { clearTimeout(t); resolveReq(v) },
              reject: e => { clearTimeout(t); rejectReq(e) },
            })
            proc.stdin.write(JSON.stringify({ id, query, mode, topK }) + '\n')
          })
          raw.results = (raw.results ?? []).map(r => {
            const clean = sanitizePassageText(r.text)
            return { ...r, text: clean.text, injectionFlags: clean.injectionFlags }
          })
          out = { ...raw, cacheHit: false }
        }
      } catch {
        // Fall through cleanly to in-process deterministic BM25
      }
    }
    if (!out) {
      out = { ...this.fallback.search(query, topK), cacheHit: false }
    }

    if (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(normalizedKey, out)
    return out
  }

  close() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
      this.proc = null
    }
  }
}
